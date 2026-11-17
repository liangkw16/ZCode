#import "../native/macos/protocol.h"
#include <cassert>
#include <chrono>
#include <thread>
#include <unistd.h>
#include <signal.h>
static std::atomic<int> dispatchCount{0};
static bool fixtureStall = false;
id KCUADispatch(NSString *method, NSDictionary *params, const KCUAOp &op) {
  (void)params;
  if ([method isEqual:@"fixture_hold"]) {
    op->dispatched = true; dispatchCount++;
    while (fixtureStall || !op->cancelled) std::this_thread::sleep_for(std::chrono::milliseconds(2));
    KCUACheck(op);
  }
  return @{@"observed": @YES};
}
void KCUACleanup(const KCUAOp &op) { if (op->dispatched) std::this_thread::sleep_for(std::chrono::milliseconds(80)); }
int main(int argc, const char *argv[]) {
 (void)argv; fixtureStall = argc > 1; if (fixtureStall) signal(SIGTERM, SIG_IGN);
 @autoreleasepool {
  char dir[] = "/tmp/kcua-coordinator-XXXXXX"; assert(mkdtemp(dir));
  NSString *path = [NSString stringWithUTF8String:dir];
  KCUACoordinatorStart(path, [path stringByAppendingPathComponent:@"socket"]);
  NSDictionary *context = @{@"session": @"one", @"operationId": @"hold-one", @"epoch": @0};
  std::atomic<bool> closed{false}; NSDictionary *result;
  std::thread execute([&] { @autoreleasepool { result = KCUASubmit(@"fixture_hold", @{}, @"peer", context, &closed); } });
  while (!dispatchCount) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  auto start = std::chrono::steady_clock::now();
  NSDictionary *cancel = KCUAControl(@"operation_cancel", @{@"operation_id": @"hold-one"}, @"peer", context);
  auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count();
  if (fixtureStall) { assert(![cancel[@"result"][@"cleanup_complete"] boolValue]); for (;;) pause(); }
  assert([cancel[@"result"][@"cleanup_complete"] boolValue]); assert(elapsed >= 75); execute.join();
  assert([result[@"error"][@"code"] isEqual:@"cancelled"]);
  auto duplicate = KCUASubmit(@"fixture_hold", @{}, @"peer", context, &closed);
  assert(![duplicate[@"ok"] boolValue]); assert(dispatchCount == 1);
  NSDictionary *nextContext = @{@"session": @"one", @"operationId": @"observe-two", @"epoch": @1};
  auto observed = KCUASubmit(@"list_windows", @{}, @"peer", nextContext, &closed);
  assert([observed[@"result"][@"observed"] boolValue]);
  auto stale = KCUASubmit(@"list_windows", @{}, @"peer", @{@"session": @"one", @"operationId": @"old-epoch", @"epoch": @0}, &closed);
  assert([stale[@"error"][@"code"] isEqual:@"stale_state"]);
  KCUAControl(@"session_release", @{}, @"peer", @{@"session": @"one", @"epoch": @1});
  auto stopped = KCUASubmit(@"list_windows", @{}, @"peer", @{@"session": @"one", @"operationId": @"three", @"epoch": @2}, &closed);
  assert([stopped[@"error"][@"code"] isEqual:@"control_stopped"]);
  auto other = KCUASubmit(@"list_windows", @{}, @"peer", @{@"session": @"two", @"operationId": @"four", @"epoch": @0}, &closed);
  assert([other[@"ok"] boolValue]);
  KCUACoordinatorStop(); [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  puts("native cancel/drain, duplicate, continuation and session isolation passed");
 }
}
