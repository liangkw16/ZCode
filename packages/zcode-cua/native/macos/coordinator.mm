#import "protocol.h"
#include <algorithm>
#include <chrono>
#include <deque>
#include <fcntl.h>
#include <libproc.h>
#include <map>
#include <set>
#include <signal.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

static std::mutex queueMutex;
static std::condition_variable queueChanged;
static std::deque<KCUAOp> queue;
static std::map<std::string, KCUAOp> operations;
// false 表示已封口仍在排空，true 表示可以清除操作明细。
static std::map<std::string, bool> closedSessions;
static std::map<std::string, KCUAOp> activeScopes;
static std::map<std::string, uint64_t> sessionEpochs;
static std::thread worker;
static bool stopping = false;
static std::atomic<bool> recovering{false};
static std::atomic<uint64_t> desktopEpoch{0};
static NSString *runtimePath;
static NSString *brokerPath;
static NSString *leaseIdentity;
static NSString *generation;
static thread_local KCUAOp currentOperation;
KCUAOp KCUACurrentOperation(void) { return currentOperation; }

// 进程身份：pid、启动时间与可执行路径。格式与旧 producer 一致，互相都能认出对方仍在运行；
// 启动时间在进程生命周期内不变，PID 被别的进程复用后对不上。
static NSString *processIdentity(pid_t pid) {
  NSTask *ps = [NSTask new];
  ps.executableURL = [NSURL fileURLWithPath:@"/bin/ps"];
  ps.arguments = @[
    @"-p", [NSString stringWithFormat:@"%d", pid], @"-o", @"lstart=", @"-o",
    @"comm="
  ];
  NSPipe *pipe = [NSPipe pipe];
  ps.standardOutput = pipe;
  ps.standardError = [NSFileHandle fileHandleWithNullDevice];
  if (![ps launchAndReturnError:nil])
    return nil;
  NSData *identity = [pipe.fileHandleForReading readDataToEndOfFile];
  [ps waitUntilExit];
  NSString *text = [[NSString alloc] initWithData:identity
                                         encoding:NSUTF8StringEncoding];
  text = [text stringByTrimmingCharactersInSet:
                    NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return text.length ? [NSString stringWithFormat:@"darwin:%d:%@", pid, text]
                     : nil;
}

NSString *KCUAExecutable(pid_t pid) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {};
  return proc_pidpath(pid, path, sizeof(path)) > 0
             ? [NSString stringWithUTF8String:path]
             : nil;
}
NSString *KCUAProcessBirth(pid_t pid) {
  struct proc_bsdinfo info = {};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) !=
      sizeof(info))
    return nil;
  return [NSString stringWithFormat:@"%d:%llu:%llu", pid, info.pbi_start_tvsec,
                                    info.pbi_start_tvusec];
}
NSString *KCUAGeneration(void) { return generation; }
bool KCUAIsReadOnly(NSString *method) {
  static NSSet *methods;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    methods = [NSSet setWithArray:@[
      @"broker_info", @"controller_status", @"request_access",
      @"permission_status", @"input_permission_status",
      @"screen_capture_status", @"screen_capture_probe",
      @"supports_accessibility", @"list_applications", @"application_info",
      @"list_windows", @"capture_app", @"element_at_point", @"read_element",
      @"is_focus_steal_prevented", @"pip_is_running", @"pip_clear_dismissed",
      @"pip_session_handshake"
    ]];
  });
  return [methods containsObject:method];
}
bool KCUAMainLoopResponsive(double seconds) {
  if ([NSThread isMainThread])
    return true;
  dispatch_semaphore_t roundtrip = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_main_queue(), ^{
    dispatch_semaphore_signal(roundtrip);
  });
  return dispatch_semaphore_wait(
             roundtrip, dispatch_time(DISPATCH_TIME_NOW,
                                      (int64_t)(seconds * NSEC_PER_SEC))) == 0;
}
static void checkPrivatePath(NSString *path, bool directory) {
  struct stat st;
  if (lstat(path.fileSystemRepresentation, &st) != 0 || S_ISLNK(st.st_mode) ||
      st.st_uid != getuid() || (st.st_mode & 0077) ||
      (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)))
    KCUAFail(@"not_authorized", @"Unsafe CUA private runtime path");
}
static NSString *leaseFile(void) {
  return [runtimePath stringByAppendingPathComponent:@"controller-lease.json"];
}
static NSDictionary *readLease(void) {
  NSString *path = leaseFile();
  struct stat st;
  if (lstat(path.fileSystemRepresentation, &st) != 0)
    return nil;
  checkPrivatePath(path, false);
  if (st.st_size > 8192)
    KCUAFail(@"controller_busy", @"CUA lease exceeds size limit");
  int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0)
    KCUAFail(@"controller_busy", @"CUA lease cannot be read safely");
  // 坏文件无法确认归属，只能保留并拒绝新的控制会话；消息带上路径，便于人工处理。
  // 回执字段（not_sent）由 acquireLeaseBeforeDispatch 统一补上。
  NSString *malformedLeaseMessage = [NSString
      stringWithFormat:
          @"CUA lease at %@ is malformed; remove it to let a new controller start",
          path];
  char bytes[8193];
  ssize_t count = read(fd, bytes, 8192);
  close(fd);
  if (count <= 0)
    KCUAFail(@"controller_busy", malformedLeaseMessage);
  id record = [NSJSONSerialization
      JSONObjectWithData:[NSData dataWithBytes:bytes length:(NSUInteger)count]
                 options:0
                   error:nil];
  if (![record isKindOfClass:[NSDictionary class]] ||
      [record[@"schema"] intValue] != 1 ||
      ![record[@"pid"] isKindOfClass:[NSNumber class]] ||
      [record[@"pid"] intValue] < 1)
    KCUAFail(@"controller_busy", malformedLeaseMessage);
  return record;
}
// 读不到或解析不了的 lease 无法确认归属：状态查询如实报告，释放与后台回收都不碰它。
// 只有获取 lease 的路径按 controller_busy 拒绝，不会把坏文件当成自己的删掉。
static NSDictionary *readLeaseQuietly(bool *malformed) {
  *malformed = false;
  @try {
    return readLease();
  } @catch (NSException *error) {
    *malformed = ![error.name isEqual:@"not_authorized"];
    return nil;
  }
}
// lease 记录的 owner 是否仍是同一个进程。修复原因：原先只看 PID 是否还存在，记录的进程退出后
// PID 被无关程序复用，新控制会话会一直 controller_busy。现在核对记录的进程身份；
// 记录里没有身份、或当前身份算不出来时无法确认，按仍在占用处理。
static bool leaseOwnerAlive(NSDictionary *owner) {
  pid_t pid = [owner[@"pid"] intValue];
  NSString *recorded = owner[@"processIdentity"];
  bool exists = kill(pid, 0) == 0 || errno == EPERM;
  if (!recorded || !exists)
    return exists;
  NSString *current = processIdentity(pid);
  return !current || [current isEqual:recorded];
}
NSDictionary *KCUALeaseStatus(void) {
  bool malformed = false;
  NSDictionary *owner = readLeaseQuietly(&malformed);
  bool alive = owner && leaseOwnerAlive(owner);
  return @{
    @"controlled" : @(alive),
    @"owner" : owner ?: [NSNull null],
    @"is_owner" : @(alive && [owner[@"pid"] intValue] == getpid() &&
                    [owner[@"processIdentity"] isEqual:leaseIdentity]),
    @"malformed" : @(malformed)
  };
}
size_t KCUAActiveOperationCount(void) {
  std::lock_guard<std::mutex> lock(queueMutex);
  size_t count = 0;
  for (const auto &entry : operations)
    if (!entry.second->settled)
      ++count;
  return count;
}
void KCUAAcquireLease(void) {
  NSString *lock = [runtimePath
      stringByAppendingPathComponent:@".controller-lease-reclaim.lock"];
  NSString *aux = [runtimePath
      stringByAppendingPathComponent:@".controller-lease-reclaim.guard"];
  int guard =
      open(aux.fileSystemRepresentation, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (guard < 0)
    KCUAFail(@"controller_busy", @"Cannot acquire lease recovery guard");
  @try {
    checkPrivatePath(aux, false);
  } @catch (NSException *error) {
    close(guard);
    @throw;
  }
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (flock(guard, LOCK_EX | LOCK_NB) != 0) {
    if ((errno != EWOULDBLOCK && errno != EAGAIN) ||
        std::chrono::steady_clock::now() >= deadline) {
      close(guard);
      KCUAFail(@"controller_busy", @"Another lease recovery is active");
    }
    if (currentOperation) {
      @try {
        KCUACheck(currentOperation);
      } @catch (NSException *error) {
        close(guard);
        @throw;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  NSString *staging =
      [runtimePath stringByAppendingFormat:@"/.controller-reclaim-%d-%@.tmp",
                                           getpid(), [NSUUID UUID].UUIDString];
  bool published = false;
  @try {
    struct stat existing = {};
    if (lstat(lock.fileSystemRepresentation, &existing) == 0) {
      checkPrivatePath(lock, true);
      NSString *ownerPath = [lock stringByAppendingPathComponent:@"owner.json"];
      // 旧 producer 的空目录没有可证明的 owner，不能按超时擅自抢占。
      if (access(ownerPath.fileSystemRepresentation, F_OK) != 0)
        KCUAFail(@"controller_busy",
                 @"Legacy lease reclaimer has no provable owner");
      checkPrivatePath(ownerPath, false);
      NSDictionary *owner = [NSJSONSerialization
          JSONObjectWithData:[NSData dataWithContentsOfFile:ownerPath]
                     options:0
                       error:nil];
      pid_t pid = [owner[@"pid"] intValue];
      if ([owner[@"schema"] intValue] != 1 ||
          ![owner[@"kind"] isEqual:@"kcode-cua"] || pid <= 1 ||
          kill(pid, 0) == 0 || errno != ESRCH)
        KCUAFail(@"controller_busy",
                 @"Lease reclaimer owner is live or unknown");
      if (unlink(ownerPath.fileSystemRepresentation) != 0 ||
          rmdir(lock.fileSystemRepresentation) != 0)
        KCUAFail(@"controller_busy", @"Cannot reclaim a dead lease reclaimer");
    }
    if (mkdir(staging.fileSystemRepresentation, 0700) != 0)
      KCUAFail(@"controller_busy", @"Cannot stage lease reclaimer");
    NSString *ownerPath =
        [staging stringByAppendingPathComponent:@"owner.json"];
    NSData *ownerData = [NSJSONSerialization dataWithJSONObject:@{
      @"schema" : @1,
      @"kind" : @"kcode-cua",
      @"pid" : @(getpid()),
      @"birth" : KCUAProcessBirth(getpid())
    }
                                                        options:0
                                                          error:nil];
    int ownerFD = open(ownerPath.fileSystemRepresentation,
                       O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (ownerFD < 0)
      KCUAFail(@"controller_busy", @"Cannot persist lease reclaimer identity");
    ssize_t written = write(ownerFD, ownerData.bytes, ownerData.length);
    fsync(ownerFD);
    close(ownerFD);
    if (written != (ssize_t)ownerData.length ||
        renamex_np(staging.fileSystemRepresentation,
                   lock.fileSystemRepresentation, RENAME_EXCL) != 0)
      KCUAFail(@"controller_busy", @"Another controller won lease reclamation");
    published = true;
    NSDictionary *owner = readLease();
    if (owner) {
      pid_t pid = [owner[@"pid"] intValue];
      if (pid == getpid() && [owner[@"processIdentity"] isEqual:leaseIdentity])
        return;
      if (leaseOwnerAlive(owner))
        KCUAFail(
            @"controller_busy",
            @"Another live computer-use controller owns the desktop",
            @{@"action_sent" : @NO,
              @"controller" : owner});
      if (unlink(leaseFile().fileSystemRepresentation) != 0)
        KCUAFail(@"controller_busy", @"Cannot reclaim dead controller lease");
    }
    NSDictionary *record = @{
      @"schema" : @1,
      @"pid" : @(getpid()),
      @"processIdentity" : leaseIdentity,
      @"appIdentity" : @{
        @"bundleId" : @"dev.zcode.cua-helper.kcode",
        @"name" : @"KCode Computer Use",
        @"teamId" : [NSNull null]
      },
      @"variant" : @"kcode",
      @"version" : @KCODE_BUILD_ID,
      @"startedAtEpochMs" :
          @((long long)([NSDate date].timeIntervalSince1970 * 1000)),
      @"socketPath" : brokerPath,
      @"helperPath" : KCUAExecutable(getpid())
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:record
                                                   options:0
                                                     error:nil];
    // 修复原因：lease 原先以最终文件名创建后再写入，进程在两步之间退出会留下空文件，
    // 后续 Helper 读到它只能报 malformed。现在先写完临时文件再原子发布；
    // RENAME_EXCL 保证同时只有一个进程能拿到这个名字。
    NSString *staged =
        [runtimePath stringByAppendingFormat:@"/.controller-lease-%d-%@.tmp",
                                         getpid(), [NSUUID UUID].UUIDString];
    int fd = open(staged.fileSystemRepresentation,
                  O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0)
      KCUAFail(@"controller_busy", @"Could not acquire controller lease");
    @try {
      ssize_t count = write(fd, data.bytes, data.length);
      fsync(fd);
      close(fd);
      if (count != (ssize_t)data.length ||
          renamex_np(staged.fileSystemRepresentation,
                     leaseFile().fileSystemRepresentation, RENAME_EXCL) != 0)
        KCUAFail(@"controller_busy", @"Could not persist controller lease");
    } @finally {
      unlink(staged.fileSystemRepresentation);
    }
  } @finally {
    if (published) {
      unlink([lock stringByAppendingPathComponent:@"owner.json"]
                 .fileSystemRepresentation);
      rmdir(lock.fileSystemRepresentation);
    }
    unlink([staging stringByAppendingPathComponent:@"owner.json"]
               .fileSystemRepresentation);
    rmdir(staging.fileSystemRepresentation);
    flock(guard, LOCK_UN);
    close(guard);
  }
}
void KCUAReleaseLease(void) {
  // 只在能证明 lease 属于本进程时删除。这个函数运行在 worker 线程的收尾、控制请求和后台
  // 回收线程里，读不到或解析不了时不能抛出：无法确认归属的 lease 原样保留。
  bool malformed = false;
  NSDictionary *owner = readLeaseQuietly(&malformed);
  if ([owner[@"pid"] intValue] == getpid() &&
      [owner[@"processIdentity"] isEqual:leaseIdentity])
    unlink(leaseFile().fileSystemRepresentation);
}
// 修复原因：另一台 Helper 活着并持有 lease 时，拒绝只带 action_sent，没有 dispatch_status
// （跨进程 lease 夹具首先在这里失败）。回执契约要求“已证明未派发”的拒绝同时给出
// action_sent=false 与 dispatch_status=not_sent。lease 只在派发前获取，获取失败一律发生在
// 任何输入发出之前，所以在这里统一补上，不逐条依赖各个拒绝分支自带的字段。
static void acquireLeaseBeforeDispatch(void) {
  @try {
    KCUAAcquireLease();
  } @catch (NSException *error) {
    NSMutableDictionary *details =
        [error.userInfo mutableCopy] ?: [NSMutableDictionary dictionary];
    details[@"action_sent"] = @NO;
    details[@"dispatch_status"] = @"not_sent";
    KCUAFail(error.name, error.reason, details);
  }
}
static void releaseLeaseIfIdle(void) {
  if (!activeScopes.empty())
    return;
  for (const auto &entry : operations)
    if (!entry.second->settled && !KCUAIsReadOnly(entry.second->method) &&
        ![entry.second->method hasPrefix:@"pip_"])
      return;
  KCUAReleaseLease();
}
// 调用方必须持有 queueMutex。
static void cancelOperationLocked(const KCUAOp &op) {
  bool first = !op->cancelled.exchange(true);
  if (!first)
    return;
  for (auto it = queue.begin(); it != queue.end(); ++it) {
    if (*it != op)
      continue;
    // 修复原因：排队项要等前面的操作结束才能被 worker 标记落定，原先取消线程等 5 秒后
    // 向整个 Helper 发 SIGTERM，正在执行的长按等正常输入随之中断。未开始的项没有派发过
    // 任何输入，直接出队并立即回 not_sent；恢复计时只留给已经开始的工作。
    queue.erase(it);
    std::lock_guard<std::mutex> lock(op->mutex);
    op->response = KCUAError(
        @"cancelled", @"CUA operation cancelled before dispatch", @{
          @"action_sent" : @NO,
          @"dispatch_status" : @"not_sent"
        });
    op->cleanupComplete = true;
    op->settled = true;
    op->changed.notify_all();
    return;
  }
  if (op->settled.load())
    return;
  std::thread([op] {
    std::unique_lock<std::mutex> lock(op->mutex);
    if (op->changed.wait_for(lock, std::chrono::seconds(5),
                             [&] { return op->settled.load(); }))
      return;
    bool expected = false;
    if (!recovering.compare_exchange_strong(expected, true))
      return;
    // 原生工作未排空时先冻结全局 admission，再请求自身受控退出；绝不另起并行
    // owner。
    kill(getpid(), SIGTERM);
    if (op->changed.wait_for(lock, std::chrono::seconds(3),
                             [&] { return op->settled.load(); }))
      return;
    _exit(75);
  }).detach();
}
static void cancelOperation(const KCUAOp &op) {
  std::lock_guard<std::mutex> lock(queueMutex);
  cancelOperationLocked(op);
}
static std::string sessionKey(NSString *peer, NSString *session);
void KCUACheck(const KCUAOp &op) {
  bool stale = false;
  {
    std::lock_guard<std::mutex> lock(queueMutex);
    auto found = sessionEpochs.find(sessionKey(op->peer, op->session));
    stale = found != sessionEpochs.end() && op->epoch < found->second;
  }
  // 已入队的旧 cell 也必须过 epoch 栅栏，不能只拦取消之后新到达的请求。
  if (stale)
    cancelOperation(op);
  if (op->cancelled.load())
    KCUAFail(
        @"cancelled", @"CUA operation cancelled", @{
          @"action_sent" : @(op->dispatched.load()),
          @"dispatch_status" : op->dispatched.load() ? @"possibly_sent"
                                                     : @"not_sent"
        });
}
static std::string operationKey(NSString *peer, NSString *session,
                                NSString *opId) {
  NSData *key = [NSJSONSerialization dataWithJSONObject:@[ peer, session, opId ]
                                                options:0
                                                  error:nil];
  return std::string((const char *)key.bytes, key.length);
}
static std::string sessionKey(NSString *peer, NSString *session) {
  return operationKey(peer, session, @"");
}
static KCUAOp getOperation(NSString *method, NSDictionary *params,
                           NSString *peer, NSDictionary *context) {
  NSString *session = context[@"session"] ?: @"legacy";
  NSString *opId = context[@"operationId"] ?: [NSUUID UUID].UUIDString;
  std::string key = operationKey(peer, session, opId);
  auto found = operations.find(key);
  if (found != operations.end())
    return found->second;
  if (operations.size() >= 32768) {
    // 满额时请求尚未入队。保留幂等键，待会话释放后回收容量。
    KCUAFail(
        @"broker_unavailable",
        @"Native operation ledger capacity reached; release a session to reclaim capacity",
        @{@"action_sent" : @NO, @"dispatch_status" : @"not_sent"});
  }
  auto op = std::make_shared<KCUAOperation>();
  op->key = key;
  op->peer = peer;
  op->session = session;
  op->operationId = opId;
  op->method = method;
  op->params = params;
  op->epoch = context[@"epoch"] ? [context[@"epoch"] unsignedLongLongValue]
                                : sessionEpochs[sessionKey(peer, session)];
  operations[key] = op;
  return op;
}
void KCUACoordinatorStart(NSString *runtimeDir, NSString *socketPath) {
  runtimePath = runtimeDir;
  brokerPath = socketPath;
  generation = [NSUUID UUID].UUIDString;
  if (mkdir(runtimePath.fileSystemRepresentation, 0700) != 0 && errno != EEXIST)
    KCUAFail(@"broker_unavailable",
             @"Cannot create private CUA runtime directory");
  checkPrivatePath(runtimePath, true);
  // 保留旧 lease 的 processIdentity 格式，使旧 producer
  // 也能识别本进程仍然存活。
  leaseIdentity = processIdentity(getpid());
  worker = std::thread([] {
    while (true) {
      KCUAOp op;
      {
        std::unique_lock<std::mutex> lock(queueMutex);
        queueChanged.wait(lock, [] { return stopping || !queue.empty(); });
        if (stopping && queue.empty())
          break;
        op = queue.front();
        queue.pop_front();
      }
      @autoreleasepool {
        NSDictionary *response;
        bool cleanupSafe = true;
        currentOperation = op;
        @try {
          KCUACheck(op);
          if (!KCUAIsReadOnly(op->method) &&
              ![op->method isEqual:@"pip_session_event"])
            acquireLeaseBeforeDispatch();
          id result = KCUADispatch(op->method, op->params, op);
          response = KCUAOK(result);
        } @catch (NSException *error) {
          if ([error.name isEqual:@"cleanup_incomplete"])
            cleanupSafe = false;
          NSMutableDictionary *details =
              [error.userInfo mutableCopy] ?: [NSMutableDictionary dictionary];
          // 派发状态由 scheduler
          // 唯一签发；长动作后续校验失败不能把早先输入误报为 not_sent。
          if (op->dispatched) {
            details[@"action_sent"] = @YES;
            details[@"dispatch_status"] = @"possibly_sent";
          }
          response = KCUAError(error.name, error.reason, details);
        } @finally {
          @try {
            KCUACleanup(op);
          } @catch (NSException *error) {
            cleanupSafe = false;
            response = KCUAError(
                @"cleanup_incomplete", error.reason, @{
                  @"action_sent" : @(op->dispatched.load()),
                  @"dispatch_status" : @"possibly_sent"
                });
          }
        }
        currentOperation.reset();
        {
          std::lock_guard<std::mutex> lock(op->mutex);
          op->response = response;
          op->cleanupComplete = cleanupSafe;
          op->settled = true;
        }
        {
          std::lock_guard<std::mutex> lock(queueMutex);
          if (cleanupSafe)
            releaseLeaseIfIdle();
        }
        op->changed.notify_all();
        if (!cleanupSafe) {
          recovering = true;
          kill(getpid(), SIGTERM);
        }
      }
    }
  });
}
NSDictionary *KCUASubmit(NSString *method, NSDictionary *params, NSString *peer,
                         NSDictionary *context,
                         std::atomic<bool> *connectionClosed) {
  KCUAOp op;
  {
    std::lock_guard<std::mutex> lock(queueMutex);
    if (recovering)
      return KCUAError(
          @"broker_unavailable", @"Native cleanup recovery is in progress",
          @{@"action_sent" : @NO});
    if (stopping || closedSessions.count(
                        sessionKey(peer, context[@"session"] ?: @"legacy")))
      return KCUAError(
          @"control_stopped", @"CUA session is closed",
          @{@"action_sent" : @NO});
    std::string sid = sessionKey(peer, context[@"session"] ?: @"legacy");
    if (!operations.count(operationKey(peer, context[@"session"] ?: @"legacy",
                                       context[@"operationId"] ?: @"")) &&
        context[@"epoch"] &&
        [context[@"epoch"] unsignedLongLongValue] < sessionEpochs[sid])
      return KCUAError(
          @"stale_state", @"Native cancellation epoch is stale; observe again",
          @{@"action_sent" : @NO,
            @"dispatch_status" : @"not_sent"});
    op = getOperation(method, params, peer, context);
    if (!op->method)
      return KCUAError(
          @"cancelled", @"Operation cancelled before admission",
          @{@"action_sent" : @NO});
    if (!op->settled && !op->admitted.exchange(true)) {
      if (!KCUAIsReadOnly(method) && ![method hasPrefix:@"pip_"])
        activeScopes.try_emplace(sid, op);
      queue.push_back(op);
      queueChanged.notify_one();
    }
  }
  std::unique_lock<std::mutex> lock(op->mutex);
  while (!op->settled) {
    op->changed.wait_for(lock, std::chrono::milliseconds(50));
    if (connectionClosed->load() && !op->settled) {
      // 取消按 queueMutex → op->mutex 的顺序加锁，这里必须先放开 op->mutex。
      lock.unlock();
      cancelOperation(op);
      lock.lock();
    }
  }
  NSDictionary *response = op->response;
  if (KCUAIsReadOnly(method))
    op->response = KCUAError(
        @"operation_result_expired",
        @"Observation result was delivered; request a fresh observation with a "
        @"new operation ID",
        @{@"action_sent" : @NO});
  op->params = nil;
  lock.unlock();
  if (!context[@"operationId"]) {
    std::lock_guard<std::mutex> queueLock(queueMutex);
    operations.erase(op->key);
  }
  return response;
}
static NSDictionary *controlReply(NSString *method, bool complete, bool found,
                                  bool sent, uint64_t epoch) {
  NSMutableDictionary *result = [@{
    @"cleanup_complete" : @(complete),
    @"found" : @(found),
    @"dispatch_status" : sent ? @"possibly_sent" : @"not_sent",
    @"generation" : generation,
    @"epoch" : @(epoch)
  } mutableCopy];
  if ([method isEqual:@"controller_stop"])
    result[@"stopped"] = @(complete);
  if ([method isEqual:@"cancel_input_holds"])
    result[@"released"] = @(complete);
  return KCUAOK(result);
}
NSDictionary *KCUAControl(NSString *method, NSDictionary *params,
                          NSString *peer, NSDictionary *context) {
  std::vector<KCUAOp> selected;
  NSString *session = context[@"session"] ?: @"legacy";
  const auto key = sessionKey(peer, session);
  const bool releasing = [method isEqual:@"session_release"];
  const bool cancelling = [method isEqual:@"operation_cancel"];
  const bool status = [method isEqual:@"operation_status"];
  bool readClosed = false;
  {
    std::lock_guard<std::mutex> lock(queueMutex);
    const auto closed = closedSessions.find(key);
    readClosed = closed != closedSessions.end() && (cancelling || status);
    if (closed != closedSessions.end() && closed->second &&
        (readClosed || releasing))
      return controlReply(method, true, false, true, sessionEpochs[key]);
    const bool allPeer =
        !releasing && !readClosed && [context[@"all_peer_scopes"] boolValue];
    const bool scopeControl =
        releasing ||
        [@[ @"controller_stop", @"cancel_input_holds" ] containsObject:method];
    if ([method isEqual:@"controller_stop"]) {
      for (auto it = activeScopes.begin(); it != activeScopes.end();)
        if ([it->second->peer isEqual:peer] &&
            (allPeer || [it->second->session isEqual:session]))
          it = activeScopes.erase(it);
        else
          ++it;
    }
    if (releasing) {
      closedSessions.try_emplace(key, false);
      activeScopes.erase(key);
    }
    NSString *opId = scopeControl
                         ? nil
                         : (params[@"operation_id"] ?: context[@"operationId"]);
    if (!status && !readClosed) {
      auto &epoch = sessionEpochs[key];
      epoch = std::max(epoch,
                       (uint64_t)[context[@"epoch"] unsignedLongLongValue] + 1);
      if (allPeer) {
        std::set<std::string> advanced;
        for (auto &entry : operations)
          if ([entry.second->peer isEqual:peer]) {
            auto key = sessionKey(peer, entry.second->session);
            if (advanced.insert(key).second && key != sessionKey(peer, session))
              sessionEpochs[key]++;
          }
      }
    }
    if (cancelling && opId && !readClosed) {
      NSMutableDictionary *target = [context mutableCopy];
      target[@"operationId"] = opId;
      auto op = getOperation(nil, @{}, peer, target);
      if (!op->method) {
        op->cancelled = true;
        op->response = KCUAError(
            @"cancelled", @"Cancelled before admission",
            @{@"action_sent" : @NO});
        op->cleanupComplete = true;
        op->settled = true;
      } else
        cancelOperationLocked(op);
    }
    for (auto &entry : operations)
      if ([entry.second->peer isEqual:peer] &&
          (allPeer || [entry.second->session isEqual:session]) &&
          (!opId || [entry.second->operationId isEqual:opId])) {
        selected.push_back(entry.second);
        if (!status && !readClosed)
          cancelOperationLocked(entry.second);
      }
  }
  bool complete = (!status && !readClosed) || !selected.empty(), sent = false;
  const auto cleanupDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(3);
  for (auto &op : selected) {
    std::unique_lock<std::mutex> lock(op->mutex);
    if (!status && !readClosed)
      op->changed.wait_until(lock, cleanupDeadline,
                             [&] { return op->settled.load(); });
    complete &= op->settled.load() && op->cleanupComplete.load();
    sent |= op->dispatched.load();
  }
  uint64_t currentEpoch;
  {
    std::lock_guard<std::mutex> lock(queueMutex);
    currentEpoch = sessionEpochs[key];
    if (releasing && complete) {
      // 所有旧请求已清理，迟到控制消息只读封口状态，不再创建操作。
      closedSessions[key] = true;
      for (auto it = operations.begin(); it != operations.end();) {
        if ([it->second->peer isEqual:peer] &&
            [it->second->session isEqual:session])
          it = operations.erase(it);
        else
          ++it;
      }
    }
    // 另一个 release 可能已完成排空；未知旧动作只能保守报告其派发结果。
    if (readClosed && selected.empty() && closedSessions.at(key))
      return controlReply(method, true, false, true, currentEpoch);
    if (complete)
      releaseLeaseIfIdle();
  }
  return controlReply(method, complete, !selected.empty(), sent, currentEpoch);
}
void KCUACancelPeer(NSString *peer) {
  std::lock_guard<std::mutex> lock(queueMutex);
  for (auto &entry : operations)
    if ([entry.second->peer isEqual:peer] && !entry.second->settled)
      cancelOperationLocked(entry.second);
}
void KCUACoordinatorStop(void) {
  {
    std::lock_guard<std::mutex> lock(queueMutex);
    stopping = true;
    for (auto &entry : operations)
      cancelOperationLocked(entry.second);
  }
  queueChanged.notify_all();
  if (worker.joinable())
    worker.join();
  KCUAReleaseLease();
}

uint64_t KCUADesktopEpoch(void) { return desktopEpoch.load(); }
uint64_t KCUASessionEpoch(NSString *peer, NSString *session) {
  std::lock_guard<std::mutex> lock(queueMutex);
  return sessionEpochs[sessionKey(peer, session ?: @"legacy")];
}
bool KCUASessionHasDrained(NSString *peer, NSString *session) {
  std::lock_guard<std::mutex> lock(queueMutex);
  auto closed = closedSessions.find(sessionKey(peer, session));
  return closed != closedSessions.end() && closed->second;
}
void KCUANotifyDesktopUnavailable(void) {
  std::lock_guard<std::mutex> lock(queueMutex);
  desktopEpoch++;
  for (auto &entry : sessionEpochs)
    entry.second++;
  for (auto &entry : operations)
    if (!entry.second->settled)
      cancelOperationLocked(entry.second);
}

// peer 的格式是 uid:pid:启动秒:启动微秒:可执行路径。原进程退出后 PID 即使被复用，
// 启动身份也对不上，可以确认它已经结束。
static bool peerHasEnded(NSString *peer) {
  NSArray *parts = [peer componentsSeparatedByString:@":"];
  if (parts.count < 5)
    return false;
  pid_t pid = [parts[1] intValue];
  if (pid <= 1)
    return false;
  NSString *expected =
      [NSString stringWithFormat:@"%@:%@:%@", parts[1], parts[2], parts[3]],
               *birth = KCUAProcessBirth(pid);
  return birth ? ![birth isEqual:expected]
               : (kill(pid, 0) != 0 && errno == ESRCH);
}
void KCUAReapDeadScopes(void) {
  std::lock_guard<std::mutex> lock(queueMutex);
  // 修复原因：死亡扫描原先只遍历做过写操作的会话，发现死亡后也只撤销未完成项、不删操作记录。
  // Host 退出时不会发 session_release，它的记录（尤其是只做过只读请求的 Host）会永久占用
  // 本代容量，常驻 Helper 累计到 32,768 条后所有新会话都无法入队。现在每个出现过的 peer
  // 都按进程出生身份判断，已确认死亡的走与 session_release 相同的回收。
  std::set<NSString *> peers;
  for (const auto &entry : activeScopes)
    peers.insert(entry.second->peer);
  for (const auto &entry : operations)
    peers.insert(entry.second->peer);
  for (const auto &known : peers) {
    NSString *peer = known;
    if (!peerHasEnded(peer))
      continue;
    for (auto it = operations.begin(); it != operations.end();) {
      if (![it->second->peer isEqual:peer]) {
        ++it;
        continue;
      }
      if (!it->second->settled)
        cancelOperationLocked(it->second);
      it = operations.erase(it);
    }
    for (auto it = activeScopes.begin(); it != activeScopes.end();)
      it = [it->second->peer isEqual:peer] ? activeScopes.erase(it) : ++it;
    // 会话键是 peer、session 与操作号组成的 JSON 数组，同一 peer 的键共用数组前缀。
    NSData *prefix = [NSJSONSerialization dataWithJSONObject:@[ peer ]
                                                     options:0
                                                       error:nil];
    std::string scope(
        (const char *)prefix.bytes,
        [prefix length] - 1 /* 去掉结尾的 ] */);
    scope += ',';
    for (auto it = sessionEpochs.begin(); it != sessionEpochs.end();)
      it = it->first.compare(0, scope.size(), scope) == 0
               ? sessionEpochs.erase(it)
               : ++it;
    for (auto it = closedSessions.begin(); it != closedSessions.end();)
      it = it->first.compare(0, scope.size(), scope) == 0
               ? closedSessions.erase(it)
               : ++it;
  }
  releaseLeaseIfIdle();
}
