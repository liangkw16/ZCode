#import "../native/macos/protocol.h"
#include <cassert>
#include <chrono>
#include <cstring>
#include <signal.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
static std::atomic<int> dispatchCount{0};
static bool fixtureStall = false;
extern size_t KCUAActiveOperationCount(void);
id KCUADispatch(NSString *method, NSDictionary *params, const KCUAOp &op) {
  (void)params;
  if ([method isEqual:@"fixture_hold"]) {
    op->dispatched = true;
    dispatchCount++;
    while (fixtureStall || !op->cancelled)
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    KCUACheck(op);
  }
  if ([method isEqual:@"fixture_count"]) {
    op->dispatched = true;
    dispatchCount++;
  }
  return @{@"observed" : @YES};
}
void KCUACleanup(const KCUAOp &op) {
  if (op->dispatched)
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
}
int main(int argc, const char *argv[]) {
  fixtureStall = argc > 1 && strcmp(argv[1], "--stall") == 0;
  if (fixtureStall)
    signal(SIGTERM, SIG_IGN);
  @autoreleasepool {
    char dir[] = "/tmp/kcua-coordinator-XXXXXX";
    assert(mkdtemp(dir));
    NSString *path = [NSString stringWithUTF8String:dir];
    KCUACoordinatorStart(path, [path stringByAppendingPathComponent:@"socket"]);
    if (argc > 1 && strcmp(argv[1], "--single-session-capacity") == 0) {
      std::atomic<bool> closed{false};
      NSString *session = @"persistent-session";
      NSDictionary *first = @{@"session" : session, @"operationId" : @"first"};
      assert([KCUASubmit(@"fixture_count", @{}, @"peer", first, &closed)[@"ok"] boolValue]);
      for (int index = 1; index < 32768; index++) {
        @autoreleasepool {
          auto result = KCUASubmit(@"list_windows", @{}, @"peer", @{
            @"session" : session, @"operationId" : @(index).stringValue
          }, &closed);
          assert([result[@"ok"] boolValue]);
        }
      }
      @try {
        KCUASubmit(@"fixture_count", @{}, @"peer", @{
          @"session" : session, @"operationId" : @"overflow"
        }, &closed);
        assert(false && "the next new operation must be rejected");
      } @catch (NSException *error) {
        assert([error.name isEqual:@"broker_unavailable"]);
      }
      assert([KCUASubmit(@"fixture_count", @{}, @"peer", first, &closed)[@"ok"] boolValue]);
      auto status = KCUAControl(@"operation_status", @{@"operation_id" : @"first"}, @"peer", first);
      assert([status[@"result"][@"cleanup_complete"] boolValue]);
      assert(dispatchCount == 1);
      assert([KCUAControl(@"session_release", @{}, @"peer", first)[@"result"][@"cleanup_complete"] boolValue]);
      auto replay = KCUASubmit(@"fixture_count", @{}, @"peer", first, &closed);
      assert([replay[@"error"][@"code"] isEqual:@"control_stopped"]);
      assert([KCUASubmit(@"list_windows", @{}, @"peer", @{@"session" : @"fresh"}, &closed)[@"ok"] boolValue]);
      assert(dispatchCount == 1);
      KCUACoordinatorStop();
      [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
      puts("single live session capacity reached and released without replay");
      return 0;
    }
    if (argc > 1 && strcmp(argv[1], "--capacity") == 0) {
      std::atomic<bool> closed{false};
      for (int sessionIndex = 0; sessionIndex < 16; sessionIndex++) {
        @autoreleasepool {
          NSString *session =
              [NSString stringWithFormat:@"session-%d", sessionIndex];
          for (int operationIndex = 0; operationIndex < 2048;
               operationIndex++) {
            @autoreleasepool {
              auto result = KCUASubmit(
                  @"list_windows", @{}, @"peer", @{
                    @"session" : session,
                    @"operationId" : @(operationIndex).stringValue
                  },
                  &closed);
              assert([result[@"ok"] boolValue]);
            }
          }
          auto release = KCUAControl(@"session_release", @{}, @"peer",
                                     @{@"session" : session});
          assert([release[@"result"][@"cleanup_complete"] boolValue]);
          assert(KCUASessionHasDrained(@"peer", session));
          assert(!KCUASessionHasDrained(@"other-peer", session));
        }
      }
      assert(KCUAActiveOperationCount() == 0);
      auto next = KCUASubmit(
          @"list_windows", @{}, @"peer",
          @{@"session" : @"fresh", @"operationId" : @"observe"}, &closed);
      assert([next[@"ok"] boolValue] &&
             "closed sessions must release operation capacity");
      NSDictionary *old = @{@"session" : @"session-0", @"operationId" : @"0"};
      auto replay = KCUASubmit(@"fixture_count", @{}, @"peer", old, &closed);
      assert([replay[@"error"][@"code"] isEqual:@"control_stopped"]);
      for (NSString *method in @[ @"operation_cancel", @"operation_status" ]) {
        auto late =
            KCUAControl(method, @{@"operation_id" : @"0"}, @"peer", old);
        assert([late[@"result"][@"cleanup_complete"] boolValue]);
        assert(![late[@"result"][@"found"] boolValue]);
        assert([late[@"result"][@"dispatch_status"] isEqual:@"possibly_sent"]);
      }
      assert(dispatchCount == 0);
      KCUACoordinatorStop();
      [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
      puts("32768 operations reclaimed with closed sessions fenced");
      return 0;
    }
    if (argc > 1 && strcmp(argv[1], "--release-drain") == 0) {
      NSDictionary *context =
          @{@"session" : @"draining", @"operationId" : @"hold"};
      std::atomic<bool> closed{false};
      std::thread execute([&] {
        @autoreleasepool {
          KCUASubmit(@"fixture_hold", @{}, @"peer", context, &closed);
        }
      });
      while (!dispatchCount)
        std::this_thread::yield();
      std::thread release([&] {
        @autoreleasepool {
          auto result = KCUAControl(@"session_release", @{}, @"peer", context);
          assert([result[@"result"][@"cleanup_complete"] boolValue]);
        }
      });
      while (KCUASessionEpoch(@"peer", @"draining") == 0)
        std::this_thread::yield();
      assert(!KCUASessionHasDrained(@"peer", @"draining"));
      auto late =
          KCUAControl(@"operation_cancel", @{@"operation_id" : @"not-accepted"},
                      @"peer", context);
      assert(![late[@"result"][@"cleanup_complete"] boolValue] &&
             "an unknown operation must not fabricate cleanup during drain");
      assert(![late[@"result"][@"found"] boolValue]);
      release.join();
      execute.join();
      assert(dispatchCount == 1);
      KCUACoordinatorStop();
      [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
      puts("late cancellation respects the session drain");
      return 0;
    }
    if (argc > 1 && strcmp(argv[1], "--peer-death") == 0) {
      pid_t owner = fork();
      if (owner == 0) {
        for (;;)
          pause();
      }
      NSString *peer = [NSString stringWithFormat:@"%u:%@:%@", getuid(),
                                                  KCUAProcessBirth(owner),
                                                  KCUAExecutable(owner)];
      std::atomic<bool> open{false};
      NSDictionary *scope = @{
        @"session" : @"peer-death",
        @"operationId" : @"input",
        @"epoch" : @0
      };
      KCUASubmit(@"fixture_count", @{}, peer, scope, &open);
      assert([KCUALeaseStatus()[@"controlled"] boolValue]);
      kill(owner, SIGTERM);
      waitpid(owner, nullptr, 0);
      KCUAReapDeadScopes();
      assert(![KCUALeaseStatus()[@"controlled"] boolValue]);
      assert(KCUASessionEpoch(peer, @"peer-death") == 1);
      KCUACoordinatorStop();
      [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
      puts("dead peer scope drained and lease released");
      return 0;
    }
    if (argc > 1 && (strcmp(argv[1], "--lease-reclaim") == 0 ||
                     strcmp(argv[1], "--lease-release") == 0)) {
      if (strcmp(argv[1], "--lease-reclaim") == 0) {
        pid_t dead = fork();
        if (dead == 0)
          _exit(0);
        waitpid(dead, nullptr, 0);
        NSString *lock = [path
            stringByAppendingPathComponent:@".controller-lease-reclaim.lock"];
        [[NSFileManager defaultManager]
                  createDirectoryAtPath:lock
            withIntermediateDirectories:NO
                             attributes:@{
                               NSFilePosixPermissions : @0700
                             }
                                  error:nil];
        NSData *record = [NSJSONSerialization dataWithJSONObject:@{
          @"schema" : @1,
          @"kind" : @"kcode-cua",
          @"pid" : @(dead),
          @"birth" : @"dead"
        }
                                                         options:0
                                                           error:nil];
        [record writeToFile:[lock stringByAppendingPathComponent:@"owner.json"]
                 atomically:YES];
        [[NSFileManager defaultManager]
            setAttributes:@{
              NSFilePosixPermissions : @0600
            }
             ofItemAtPath:[lock stringByAppendingPathComponent:@"owner.json"]
                    error:nil];
        KCUAAcquireLease();
        assert([KCUALeaseStatus()[@"is_owner"] boolValue]);
        puts("dead lease reclaimer recovered");
      } else {
        std::atomic<bool> open{false};
        NSDictionary *scope =
            @{@"session" : @"only",
              @"operationId" : @"input",
              @"epoch" : @0};
        KCUASubmit(@"fixture_count", @{}, @"peer", scope, &open);
        assert([KCUALeaseStatus()[@"is_owner"] boolValue]);
        auto release = KCUAControl(@"session_release", @{}, @"peer", scope);
        assert([release[@"result"][@"cleanup_complete"] boolValue]);
        assert(![KCUALeaseStatus()[@"controlled"] boolValue]);
        puts("last scope releases physical controller lease");
      }
      KCUACoordinatorStop();
      [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
      return 0;
    }
    NSDictionary *context =
        @{@"session" : @"one",
          @"operationId" : @"hold-one",
          @"epoch" : @0};
    std::atomic<bool> closed{false};
    NSDictionary *result;
    std::thread execute([&] {
      @autoreleasepool {
        result = KCUASubmit(@"fixture_hold", @{}, @"peer", context, &closed);
      }
    });
    while (!dispatchCount)
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    assert(KCUAActiveOperationCount() == 1);
    NSDictionary *queuedContext = @{
      @"session" : @"one",
      @"operationId" : @"queued-old-epoch",
      @"epoch" : @0
    };
    NSDictionary *queuedResult;
    std::thread queued([&] {
      @autoreleasepool {
        queuedResult =
            KCUASubmit(@"fixture_count", @{}, @"peer", queuedContext, &closed);
      }
    });
    auto queueDeadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(1);
    for (;;) {
      NSDictionary *status = KCUAControl(
          @"operation_status", @{@"operation_id" : @"queued-old-epoch"},
          @"peer", queuedContext);
      if ([status[@"result"][@"found"] boolValue] &&
          ![status[@"result"][@"cleanup_complete"] boolValue])
        break;
      assert(std::chrono::steady_clock::now() < queueDeadline);
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    auto start = std::chrono::steady_clock::now();
    NSDictionary *cancel =
        argc > 1 && strcmp(argv[1], "--legacy-cancel") == 0
            ? KCUAControl(
                  @"cancel_input_holds", @{}, @"peer", @{
                    @"session" : @"one",
                    @"operationId" : @"cancel-control",
                    @"epoch" : @0
                  })
            : KCUAControl(@"operation_cancel", @{@"operation_id" : @"hold-one"},
                          @"peer", context);
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::steady_clock::now() - start)
                       .count();
    if (fixtureStall) {
      assert(![cancel[@"result"][@"cleanup_complete"] boolValue]);
      for (;;)
        pause();
    }
    assert([cancel[@"result"][@"cleanup_complete"] boolValue]);
    assert(elapsed >= 75);
    execute.join();
    queued.join();
    assert(KCUAActiveOperationCount() == 0);
    assert([queuedResult[@"error"][@"code"] isEqual:@"cancelled"]);
    assert(dispatchCount == 1);
    assert([result[@"error"][@"code"] isEqual:@"cancelled"]);
    auto duplicate =
        KCUASubmit(@"fixture_hold", @{}, @"peer", context, &closed);
    assert(![duplicate[@"ok"] boolValue]);
    assert(dispatchCount == 1);
    NSDictionary *nextContext =
        @{@"session" : @"one",
          @"operationId" : @"observe-two",
          @"epoch" : @1};
    auto observed =
        KCUASubmit(@"list_windows", @{}, @"peer", nextContext, &closed);
    assert([observed[@"result"][@"observed"] boolValue]);
    auto stale = KCUASubmit(
        @"list_windows", @{}, @"peer",
        @{@"session" : @"one",
          @"operationId" : @"old-epoch",
          @"epoch" : @0},
        &closed);
    assert([stale[@"error"][@"code"] isEqual:@"stale_state"]);
    KCUANotifyDesktopUnavailable();
    auto lockedEpoch = KCUASubmit(
        @"list_windows", @{}, @"peer", @{
          @"session" : @"one",
          @"operationId" : @"locked-old-state",
          @"epoch" : @1
        },
        &closed);
    assert([lockedEpoch[@"error"][@"code"] isEqual:@"stale_state"]);
    auto unlocked = KCUASubmit(
        @"list_windows", @{}, @"peer", @{
          @"session" : @"one",
          @"operationId" : @"unlocked-state",
          @"epoch" : @2
        },
        &closed);
    assert([unlocked[@"ok"] boolValue]);
    assert(KCUADesktopEpoch() == 1);
    KCUAControl(
        @"session_release", @{}, @"peer",
        @{@"session" : @"one",
          @"epoch" : @1});
    auto stopped = KCUASubmit(
        @"list_windows", @{}, @"peer",
        @{@"session" : @"one",
          @"operationId" : @"three",
          @"epoch" : @2},
        &closed);
    assert([stopped[@"error"][@"code"] isEqual:@"control_stopped"]);
    auto other = KCUASubmit(
        @"list_windows", @{}, @"peer",
        @{@"session" : @"two",
          @"operationId" : @"four",
          @"epoch" : @0},
        &closed);
    assert([other[@"ok"] boolValue]);
    KCUACoordinatorStop();
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    puts("native cancel/drain, duplicate, continuation and session isolation "
         "passed");
  }
}
