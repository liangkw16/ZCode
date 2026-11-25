#import "../native/macos/protocol.h"
#include <cassert>
// permissions.mm 的其余依赖在这里用不到：本用例只验证准入错误的形状。
void KCUANotifyDesktopUnavailable(void) {}
void KCUASuspendPresentationForDesktop(void) {}
void KCUAReapDeadScopes(void) {}
int main(void) {
  @autoreleasepool {
    assert(KCUADesktopAdmissionError(@"unlocked") == nil);
    NSDictionary *locked = KCUADesktopAdmissionError(@"locked");
    assert([locked[@"error"][@"code"] isEqual:@"permission_denied"]);
    NSDictionary *details = locked[@"error"][@"details"];
    // 规范 §8.2：锁屏沿用 permission_denied / reason:screen_locked / action_sent:false。
    assert([details[@"reason"] isEqual:@"screen_locked"]);
    assert([details[@"action_sent"] isEqual:@NO]);
    assert([details[@"dispatch_status"] isEqual:@"not_sent"]);
    assert([details[@"desktop_availability"] isEqual:@"locked"]);
    // 锁定状态无法确定时同样拒绝，但不能冒充已确认的锁屏。
    NSDictionary *unknown = KCUADesktopAdmissionError(@"unknown");
    assert([unknown[@"error"][@"code"] isEqual:@"permission_denied"]);
    assert(![unknown[@"error"][@"details"][@"reason"] isEqual:@"screen_locked"]);
    assert([unknown[@"error"][@"details"][@"action_sent"] isEqual:@NO]);
    puts("desktop admission regressions passed");
  }
}
