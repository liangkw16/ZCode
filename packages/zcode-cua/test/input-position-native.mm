#import "../native/macos/automation.h"
#include <ApplicationServices/ApplicationServices.h>
#include <cassert>
#include <vector>

// 带目标的 type：定位（AX 聚焦或点击）必须在同一次原生操作里完成，且只接受本窗口的元素。
// 运行时把 focus_native / click_native / click_point 随 type_text_to_app 一起下发。
struct Delivery {
  CGEventType type;
  CGPoint point;
};
static std::vector<Delivery> deliveries;
static KCUATargetRef original;
static std::vector<CFStringRef> focusCalls;
static bool focusFails = false;

extern "C" void CGEventPostToPid(pid_t pid, CGEventRef event) {
  (void)pid;
  deliveries.push_back(
      {CGEventGetType(event), CGEventGetLocation(event)});
}
extern "C" AXError AXUIElementSetAttributeValue(AXUIElementRef element,
                                               CFStringRef attribute,
                                               CFTypeRef value) {
  (void)element;
  (void)value;
  focusCalls.push_back(attribute);
  return focusFails ? kAXErrorFailure : kAXErrorSuccess;
}
NSString *KCUAProcessBirth(pid_t pid) { return pid == original->pid ? original->birth : nil; }
NSString *KCUAGeneration(void) { return @"position-test"; }
uint64_t KCUADesktopEpoch(void) { return 0; }
void KCUACheck(const KCUAOp &op) {
  if (op->cancelled)
    KCUAFail(@"cancelled", @"fixture cancellation");
}
void KCUARequireAccessibility(void) {}
void KCUARequireDesktop(void) {}
KCUATargetRef KCUAResolveTarget(NSDictionary *, const KCUAOp &, bool) {
  return original;
}
void KCUAValidateTarget(const KCUATargetRef &, bool) {}
void KCUARequireInputKeyWindow(const KCUATargetRef &, bool) {}
KCUATargetRef KCUAResolveInputReleaseTarget(pid_t pid, NSString *birth,
                                            CGWindowID window) {
  assert(pid == original->pid && [birth isEqual:original->birth]);
  assert(window == original->windowId);
  auto verified = std::make_shared<KCUATarget>();
  verified->pid = pid;
  verified->birth = birth;
  verified->windowId = window;
  verified->bounds = original->bounds;
  return verified;
}
static AXUIElementRef element = (AXUIElementRef)0x1234;
AXUIElementRef KCUAResolveElement(NSDictionary *params, const KCUAOp &,
                                  KCUATargetRef *owner) {
  NSString *token = params[@"native"];
  *owner = std::make_shared<KCUATarget>(*original);
  if ([token isEqual:@"tok-a"])
    return element;
  if ([token isEqual:@"tok-other-window"]) {
    (*owner)->windowId = 99;
    return element;
  }
  return nullptr;
}
id KCUAAXAttribute(AXUIElementRef, CFStringRef) { return nil; }
CGRect KCUAAXBounds(AXUIElementRef) { return CGRectMake(110, 210, 200, 100); }
void KCUABeginScopedFocus(const KCUATargetRef &, const KCUAOp &) {}
void KCUAEndScopedFocus(void) {}
void KCUAGhostHide(void) {}
void KCUAGhostPoint(CGPoint) {}
NSDictionary *KCUAScopedFocusRecoveryRecord(void) { return @{}; }
void KCUARecoverScopedFocus(NSDictionary *) {}
void KCUAStampWindowEvent(CGEventRef event, const KCUATargetRef &target) {
  CGEventSetIntegerValueField(event, kCGEventSourceUserData, target->windowId);
}

static KCUAOp operation(void) {
  auto op = std::make_shared<KCUAOperation>();
  op->peer = @"fixture-peer";
  op->session = @"fixture-session";
  return op;
}
static NSException *capture(void (^body)(void)) {
  @try {
    body();
  } @catch (NSException *error) {
    return error;
  }
  return nil;
}
static void expectFailure(NSException *error, NSString *code, NSNumber *sent) {
  assert(error && [error.name isEqual:code]);
  // 取消由 KCUACheck 抛出，夹具的桩不带 details；其余失败都必须明确声明是否已发送。
  assert(!sent || [error.userInfo[@"action_sent"] isEqual:sent]);
}

int main(void) {
  @autoreleasepool {
    original = std::make_shared<KCUATarget>();
    original->pid = 101;
    original->birth = @"fixture-birth";
    original->windowId = 17;
    original->bounds = CGRectMake(100, 200, 400, 500);

    auto op = operation();
    KCUAPositionTyping(@{ @"focus_native" : @"tok-a" }, original, op);
    assert(focusCalls.size() == 1 &&
           CFEqual(focusCalls[0], kAXFocusedAttribute));
    assert(op->dispatched && deliveries.empty());
    KCUAInputCleanup(op);

    // 显式事件路径不碰 AX 焦点：按元素当前中心点击一次。
    op = operation();
    KCUAPositionTyping(@{ @"click_native" : @"tok-a" }, original, op);
    assert(focusCalls.size() == 1);
    assert(deliveries.size() == 2 &&
           deliveries[0].type == kCGEventLeftMouseDown &&
           deliveries[1].type == kCGEventLeftMouseUp);
    assert(CGPointEqualToPoint(deliveries[0].point, CGPointMake(210, 260)));
    KCUAInputCleanup(op);

    op = operation();
    KCUAPositionTyping(@{ @"click_point" : @{ @"x" : @130, @"y" : @240 } },
                       original, op);
    assert(deliveries.size() == 4 &&
           CGPointEqualToPoint(deliveries[2].point, CGPointMake(130, 240)));
    KCUAInputCleanup(op);

    deliveries.clear();
    expectFailure(capture(^{
      KCUAPositionTyping(
          @{ @"focus_native" : @"tok-a", @"click_point" : @{ @"x" : @1, @"y" : @1 } },
          original, operation());
    }), @"invalid_request", @NO);
    expectFailure(capture(^{
      KCUAPositionTyping(@{ @"focus_native" : @"tok-missing" }, original,
                         operation());
    }), @"element_unavailable", @NO);
    expectFailure(capture(^{
      KCUAPositionTyping(@{ @"click_native" : @"tok-other-window" }, original,
                         operation());
    }), @"element_unavailable", @NO);
    expectFailure(capture(^{
      KCUAPositionTyping(@{ @"click_point" : @{ @"x" : @9000, @"y" : @240 } },
                         original, operation());
    }), @"element_unavailable", @NO);
    focusFails = true;
    expectFailure(capture(^{
      KCUAPositionTyping(@{ @"focus_native" : @"tok-a" }, original,
                         operation());
    }), @"action_unavailable", @YES);
    focusFails = false;
    auto cancelled = operation();
    cancelled->cancelled = true;
    expectFailure(capture(^{
      KCUAPositionTyping(@{ @"focus_native" : @"tok-a" }, original, cancelled);
    }), @"cancelled", nil);
    assert(deliveries.empty() && focusCalls.size() == 2);

    puts("typing positioning stays inside one native operation");
  }
}
