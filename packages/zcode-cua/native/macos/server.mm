#import "protocol.h"
#import <Security/Security.h>
#include <cmath>
#include <fcntl.h>
#include <libproc.h>
#include <map>
#include <set>
#include <sys/event.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>
#include <vector>

static int listening = -1;
static std::atomic<bool> serverStopping{false};
static NSString *serverSocket;
static NSString *serviceRuntime;
static bool developmentAllowed;
static std::mutex peersMutex;
static std::map<std::string, std::string> capabilities;
static std::mutex connectionsMutex;
static std::set<int> connections;
static constexpr size_t maximumBytes = 8 * 1024 * 1024;

static NSDictionary *signingInformation(pid_t pid) {
  SecCodeRef code = nullptr;
  CFDictionaryRef info = nullptr;
  NSDictionary *attributes =
      @{(__bridge NSString *)kSecGuestAttributePid : @(pid)};
  if (SecCodeCopyGuestWithAttributes(
          nullptr, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags,
          &code) != errSecSuccess)
    return nil;
  if (SecCodeCheckValidity(code, kSecCSDefaultFlags, nullptr) !=
          errSecSuccess ||
      SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) !=
          errSecSuccess) {
    CFRelease(code);
    return nil;
  }
  CFRelease(code);
  return CFBridgingRelease(info);
}
static bool developmentSignature(void) {
  NSDictionary *info = signingInformation(getpid());
  return ([info[(__bridge NSString *)kSecCodeInfoFlags] unsignedIntValue] &
          kSecCodeSignatureAdhoc) != 0;
}
extern bool KCUATrustedProductPeer(NSData *, NSData *, NSString *, NSString *,
                                   NSString *, bool);
static NSData *signingLeaf(NSDictionary *info) {
  NSArray *certificates = info[(__bridge NSString *)kSecCodeInfoCertificates];
  if (![certificates isKindOfClass:NSArray.class] || !certificates.count)
    return nil;
  return CFBridgingRelease(SecCertificateCopyData(
      (__bridge SecCertificateRef)certificates.firstObject));
}
static pid_t parentOf(pid_t pid) {
  struct proc_bsdinfo info = {};
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) ==
                     sizeof(info) &&
                 info.pbi_uid == getuid()
             ? info.pbi_ppid
             : 0;
}
static NSString *verifiedMain(pid_t pid, NSData *leaf) {
  NSDictionary *info = signingInformation(pid);
  if (![info[(__bridge NSString *)kSecCodeInfoIdentifier]
          isEqual:@"dev.zcode.app.kcode"] ||
      ![signingLeaf(info) isEqual:leaf])
    return nil;
  NSRunningApplication *app =
      [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (![app.bundleIdentifier isEqual:@"dev.zcode.app.kcode"] ||
      app.terminated ||
      app.activationPolicy != NSApplicationActivationPolicyRegular ||
      ![app.executableURL.path isEqual:KCUAExecutable(pid)])
    return nil;
  return app.bundleURL.path.stringByResolvingSymlinksInPath;
}
static bool verifyPeer(int fd, NSString **identity,
                       bool *presentationEligible) {
  uid_t uid;
  gid_t gid;
  pid_t pid = 0;
  socklen_t len = sizeof(pid);
  if (getpeereid(fd, &uid, &gid) != 0 || uid != getuid() ||
      getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) != 0 || pid <= 1)
    return false;
  NSString *birth = KCUAProcessBirth(pid), *path = KCUAExecutable(pid);
  if (!birth || !path)
    return false;
  NSDictionary *peer = signingInformation(pid),
               *own = signingInformation(getpid());
  NSData *leaf = signingLeaf(own), *peerLeaf = signingLeaf(peer);
  NSString *identifier = peer[(__bridge NSString *)kSecCodeInfoIdentifier],
           *mainPath = nil;
  pid_t mainPid = 0, candidate = pid;
  for (int depth = 0; candidate > 1 && depth < 8; depth++) {
    mainPath = verifiedMain(candidate, leaf);
    if (mainPath) {
      mainPid = candidate;
      break;
    }
    candidate = parentOf(candidate);
  }
  bool approved = KCUATrustedProductPeer(leaf, peerLeaf, identifier, path,
                                         mainPath, mainPid > 1);
  // 本机证书可能没有 TeamIdentifier，必须比较 OS 验证后的叶证书，不能改成同 UID
  // 任意进程。
  *presentationEligible =
      approved &&
      (pid == mainPid || ([identifier isEqual:@"dev.zcode.app.kcode.helper"] &&
                          parentOf(pid) == mainPid));
  if (!approved && developmentAllowed && developmentSignature())
    approved = true;
  if (!approved || ![birth isEqual:KCUAProcessBirth(pid)] ||
      ![path isEqual:KCUAExecutable(pid)])
    return false;
  *identity = [NSString stringWithFormat:@"%u:%@:%@", uid, birth, path];
  return true;
}
static bool sendResponse(int fd, NSNumber *requestId, NSDictionary *response) {
  NSMutableDictionary *envelope = [response mutableCopy];
  envelope[@"id"] = requestId ?: @0;
  NSError *error = nil;
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:envelope
                                      options:NSJSONWritingFragmentsAllowed
                                        error:&error];
  if (!data || data.length > maximumBytes) {
    data = [NSJSONSerialization dataWithJSONObject:@{
      @"id" : requestId ?: @0,
      @"ok" : @NO,
      @"error" : @{
        @"code" : @"invalid_response",
        @"message" : @"Native response cannot be encoded within its byte limit"
      }
    }
                                           options:0
                                             error:nil];
  }
  NSMutableData *line = [data mutableCopy];
  [line appendBytes:"\n" length:1];
  const uint8_t *bytes = (const uint8_t *)line.bytes;
  size_t remaining = line.length;
  while (remaining) {
    ssize_t sent = send(fd, bytes, remaining, 0);
    if (sent <= 0)
      return false;
    bytes += sent;
    remaining -= (size_t)sent;
  }
  return true;
}
static NSNumber *requestId(id request) {
  if (![request isKindOfClass:NSDictionary.class])
    return nil;
  id value = request[@"id"];
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID())
    return nil;
  double number = [value doubleValue];
  return std::isfinite(number) && number >= 0 && number <= 9007199254740991.0 &&
                 floor(number) == number
             ? value
             : nil;
}
static void handleConnection(int fd) {
  @autoreleasepool {
    NSString *peer;
    bool presentationEligible = false;
    if (!verifyPeer(fd, &peer, &presentationEligible)) {
      sendResponse(
          fd, @0,
          KCUAError(@"not_authorized",
                    @"CUA peer executable/signature verification failed"));
      {
        std::lock_guard<std::mutex> lock(connectionsMutex);
        connections.erase(fd);
      }
      close(fd);
      return;
    }
    bool authenticated = false, presentation = false;
    NSString *capability;
    std::string buffer;
    char chunk[16384];
    std::atomic<bool> disconnected{false};
    // 只监听 EOF，不消费业务字节；业务线程阻塞在 AX 时仍能触发取消。
    int eventQueue = kqueue();
    struct kevent event;
    EV_SET(&event, fd, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, nullptr);
    kevent(eventQueue, &event, 1, nullptr, 0, nullptr);
    std::thread monitor([&] {
      while (!disconnected.load() && !serverStopping.load()) {
        struct kevent next;
        timespec timeout = {0, 50000000};
        int count = kevent(eventQueue, nullptr, 0, &next, 1, &timeout);
        if (count > 0 && (next.flags & EV_EOF)) {
          disconnected = true;
          break;
        }
      }
    });
    while (!disconnected && !serverStopping) {
      ssize_t size = recv(fd, chunk, sizeof(chunk), 0);
      if (size <= 0)
        break;
      buffer.append(chunk, (size_t)size);
      if (buffer.size() > maximumBytes) {
        sendResponse(
            fd, @0,
            KCUAError(@"invalid_request", @"Request exceeds byte limit"));
        break;
      }
      size_t newline;
      while ((newline = buffer.find('\n')) != std::string::npos) {
        @autoreleasepool {
          NSData *data = [NSData dataWithBytes:buffer.data() length:newline];
          buffer.erase(0, newline + 1);
          id request = [NSJSONSerialization JSONObjectWithData:data
                                                       options:0
                                                         error:nil];
          NSNumber *rid = requestId(request);
          NSString *method = rid ? request[@"method"] : nil;
          id params = rid ? request[@"params"] : nil;
          if (!rid || ![method isKindOfClass:NSString.class] ||
              !method.length ||
              (params && ![params isKindOfClass:NSDictionary.class])) {
            if (!sendResponse(
                    fd, rid,
                    KCUAError(
                        @"invalid_request",
                        @"Expected numeric id, method and object params")))
              disconnected = true;
            continue;
          }
          if (!params)
            params = @{};
          NSDictionary *response;
          @try {
            if ([method isEqual:@"authenticate"]) {
              NSNumber *version = params[@"clientApiVersion"];
              if ([version respondsToSelector:@selector(integerValue)] &&
                  version.integerValue > 3)
                response = KCUAError(@"version_mismatch",
                                     @"CUA broker serverApiVersion is 3");
              else if ([params[@"role"] isEqual:@"presentation"] &&
                       !presentationEligible)
                response = KCUAError(
                    @"not_authorized",
                    @"Presentation role requires the signed KCode Host");
              else {
                std::lock_guard<std::mutex> lock(peersMutex);
                std::string key = peer.UTF8String;
                auto found = capabilities.find(key);
                if (found == capabilities.end())
                  found = capabilities
                              .emplace(key, [NSUUID UUID].UUIDString.UTF8String)
                              .first;
                capability =
                    [NSString stringWithUTF8String:found->second.c_str()];
                authenticated = true;
                presentation = [params[@"role"] isEqual:@"presentation"];
                response = KCUAOK(@{
                  @"authenticated" : @YES,
                  @"serverApiVersion" : @3,
                  @"kcode" : @{
                    @"generation" : KCUAGeneration(),
                    @"capability" : capability,
                    @"cleanupFence" : @YES,
                    @"pixelsOnly" : @YES,
                    @"cancellationEpoch" : @(
                        KCUASessionEpoch(peer, [params[@"session_id"]
                                                   isKindOfClass:NSString.class]
                                                   ? params[@"session_id"]
                                                   : @"legacy")),
                    @"pid" : @(getpid()),
                    @"processBirth" : KCUAProcessBirth(getpid())
                  }
                });
              }
            } else if ([method isEqual:@"ping"]) {
              response = [params[@"clientApiVersion"] integerValue] > 3
                             ? KCUAError(@"version_mismatch",
                                         @"CUA broker serverApiVersion is 3")
                             : KCUAOK(
                                   @{@"serverApiVersion" : @3});
            } else if (!authenticated)
              response =
                  KCUAError(@"not_authorized",
                            @"Authenticate must be the first CUA request");
            else {
              bool presentationMethod =
                  [method isEqual:@"pip_session_handshake"] ||
                  [method isEqual:@"pip_session_event"];
              if (presentationMethod != presentation)
                KCUAFail(@"not_authorized",
                         @"Presentation and tool authorities are separate");
              NSDictionary *context = params[@"kcode_operation"];
              if (context) {
                if (![context isKindOfClass:NSDictionary.class] ||
                    ![context[@"epoch"] isKindOfClass:NSNumber.class] ||
                    [context[@"epoch"] doubleValue] < 0 ||
                    floor([context[@"epoch"] doubleValue]) !=
                        [context[@"epoch"] doubleValue] ||
                    !std::isfinite([context[@"epoch"] doubleValue]) ||
                    [context[@"operationId"] length] > 256 ||
                    ![context[@"capability"] isEqual:capability] ||
                    ![context[@"generation"] isEqual:KCUAGeneration()] ||
                    ![context[@"session"] isKindOfClass:NSString.class] ||
                    [context[@"session"] length] > 4096 ||
                    ![context[@"operationId"] isKindOfClass:NSString.class])
                  KCUAFail(@"not_authorized",
                           @"Invalid native operation authority or generation");
              }
              if ([method isEqual:@"operation_cancel"] ||
                  [method isEqual:@"operation_status"] ||
                  [method isEqual:@"session_release"] ||
                  [method isEqual:@"cancel_input_holds"] ||
                  [method isEqual:@"controller_stop"]) {
                bool legacyControl =
                    [@[ @"cancel_input_holds", @"controller_stop" ]
                        containsObject:method];
                if (!context && !legacyControl)
                  KCUAFail(
                      @"not_authorized",
                      @"Cleanup control requires negotiated Host authority");
                response = KCUAControl(
                    method, params, peer, context ?: @{
                      @"session" : @"legacy",
                      @"operationId" : [NSUUID UUID].UUIDString,
                      @"epoch" : @(KCUASessionEpoch(peer, @"legacy")),
                      @"all_peer_scopes" : @YES
                    });
              } else if ([method isEqual:@"broker_info"]) {
                bool responsive = KCUAMainLoopResponsive(0.5);
                response =
                    responsive
                        ? KCUAOK(@{
                            @"pid" : @(getpid()),
                            @"bundle_id" : @"dev.zcode.cua-helper.kcode",
                            @"display_name" : @"KCode Computer Use",
                            @"version" : @KCODE_BUILD_ID,
                            @"api_version" : @"ZCodeComputerUseIPC-1",
                            @"serverApiVersion" : @3,
                            @"framing" : @"ndjson",
                            @"generation" : KCUAGeneration(),
                            @"desktop_epoch" : @(KCUADesktopEpoch()),
                            @"main_loop_responsive" : @YES,
                            @"platform" : @"darwin",
                            @"capabilities" : @{@"cleanup_fence" : @YES}
                          })
                        : KCUAError(@"helper_unresponsive",
                                    @"AppKit main run loop did not respond");
              } else if ([@[
                           @"permission_status", @"request_access",
                           @"input_permission_status", @"screen_capture_status",
                           @"supports_accessibility"
                         ] containsObject:method] &&
                         !([method isEqual:@"permission_status"] &&
                           [params[@"include_functional_probes"] boolValue])) {
                if ([method isEqual:@"supports_accessibility"])
                  response = KCUAOK(@YES);
                else if ([method isEqual:@"input_permission_status"])
                  response = KCUAOK(@{
                    @"accessibility" :
                        KCUAPermissionStatus()[@"accessibility"]
                  });
                else if ([method isEqual:@"screen_capture_status"])
                  response = KCUAOK(@{
                    @"screen_recording" :
                        KCUAPermissionStatus()[@"screen_recording"]
                  });
                else
                  response = KCUAOK(KCUAPermissionStatus());
              } else if ([method isEqual:@"controller_status"]) {
                NSMutableDictionary *status = [KCUALeaseStatus() mutableCopy];
                status[@"active_operations"] = @(KCUAActiveOperationCount());
                response = KCUAOK(status);
              } else {
                static NSSet *brokerMethods;
                static dispatch_once_t once;
                dispatch_once(&once, ^{
                  brokerMethods =
                      [NSSet setWithArray:@[ KCODE_BROKER_METHODS ]];
                });
                if (![brokerMethods containsObject:method])
                  response = KCUAError(@"method_not_found",
                                       @"Unknown CUA broker method");
                else
                  response = KCUASubmit(method, params, peer, context ?: @{},
                                        &disconnected);
              }
            }
          } @catch (NSException *error) {
            response = KCUAError(error.name, error.reason, error.userInfo);
          }
          if (!sendResponse(fd, rid, response))
            disconnected = true;
        }
      }
    }
    disconnected = true;
    if (monitor.joinable())
      monitor.join();
    close(eventQueue);
    {
      std::lock_guard<std::mutex> lock(connectionsMutex);
      connections.erase(fd);
    }
    shutdown(fd, SHUT_RDWR);
    close(fd);
  }
}
void KCUAStartServer(NSString *socketPath, NSString *runtimeDir,
                     bool allowDevelopment) {
  serverSocket = socketPath;
  serviceRuntime = runtimeDir;
  developmentAllowed = allowDevelopment;
  KCUACoordinatorStart(runtimeDir, socketPath);
  KCUAInputInitialize(runtimeDir);
  KCUAStartAvailabilityTracking();
  struct stat st;
  NSString *parent = [socketPath stringByDeletingLastPathComponent];
  if (lstat(parent.fileSystemRepresentation, &st) != 0 ||
      !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode) || st.st_uid != getuid() ||
      (st.st_mode & 0077))
    KCUAFail(@"not_authorized",
             @"Socket parent must be a private user-owned directory");
  if (lstat(socketPath.fileSystemRepresentation, &st) == 0)
    KCUAFail(
        @"controller_busy",
        @"Socket already exists; lifecycle must verify and reuse its owner");
  listening = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listening < 0)
    KCUAFail(@"broker_unavailable", @"Cannot create native socket");
  int noSignal = 1;
  setsockopt(listening, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
  sockaddr_un address = {};
  address.sun_family = AF_UNIX;
  if (socketPath.length >= sizeof(address.sun_path))
    KCUAFail(@"invalid_request", @"Native socket path is too long");
  strlcpy(address.sun_path, socketPath.fileSystemRepresentation,
          sizeof(address.sun_path));
  mode_t old = umask(0077);
  int bound = bind(listening, (sockaddr *)&address, sizeof(address));
  umask(old);
  if (bound != 0 || listen(listening, 32) != 0)
    KCUAFail(@"broker_unavailable", @"Cannot bind native socket");
  chmod(socketPath.fileSystemRepresentation, 0600);
  std::thread([] {
    while (!serverStopping) {
      int fd = accept(listening, nullptr, nullptr);
      if (fd < 0) {
        if (serverStopping)
          break;
        continue;
      }
      int noSignal = 1;
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
      {
        std::lock_guard<std::mutex> lock(connectionsMutex);
        if (connections.size() >= 64) {
          close(fd);
          continue;
        }
        connections.insert(fd);
      }
      std::thread([fd] { handleConnection(fd); }).detach();
    }
  }).detach();
}
void KCUAStopServer(void) {
  serverStopping = true;
  if (listening >= 0) {
    shutdown(listening, SHUT_RDWR);
    close(listening);
    listening = -1;
  }
  {
    std::lock_guard<std::mutex> lock(connectionsMutex);
    for (int fd : connections)
      shutdown(fd, SHUT_RDWR);
  }
  KCUAStopAvailabilityTracking();
  KCUACoordinatorStop();
  if (serverSocket)
    unlink(serverSocket.fileSystemRepresentation);
}
