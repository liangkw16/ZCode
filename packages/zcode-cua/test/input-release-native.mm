#import "../native/macos/automation.h"
#include <cassert>
#include <cstring>
#include <unistd.h>
#include <vector>

struct Delivery {
  pid_t pid;
  CGWindowID window;
  CGEventType type;
  CGPoint point;
};
static std::vector<Delivery> deliveries;
static KCUATargetRef original;
static KCUAOp cancelOnDown;
static bool targetGone = false;
static CGRect currentBounds;
static CGEventType crashAt = kCGEventNull;

extern "C" void CGEventPostToPid(pid_t pid, CGEventRef event) {
  auto type = CGEventGetType(event);
  deliveries.push_back(
      {pid,
       (CGWindowID)CGEventGetIntegerValueField(event, kCGEventSourceUserData),
       type, CGEventGetLocation(event)});
  if (type == crashAt)
    _exit(75);
  if (cancelOnDown &&
      (type == kCGEventKeyDown || type == kCGEventLeftMouseDown))
    cancelOnDown->cancelled = true;
}
NSString *KCUAProcessBirth(pid_t pid) {
  return pid == original->pid ? original->birth
         : pid == getpid()    ? @"new-helper-birth"
                              : nil;
}
NSString *KCUAGeneration(void) { return @"input-test"; }
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
KCUATargetRef KCUAResolveInputReleaseTarget(pid_t pid, NSString *birth,
                                            CGWindowID window) {
  assert(pid == original->pid && [birth isEqual:original->birth]);
  assert(window == original->windowId);
  if (targetGone)
    return {};
  auto verified = std::make_shared<KCUATarget>();
  verified->pid = pid;
  verified->birth = birth;
  verified->windowId = window;
  verified->bounds = currentBounds;
  return verified;
}
AXUIElementRef KCUAResolveElement(NSDictionary *, const KCUAOp &,
                                  KCUATargetRef *) {
  assert(false);
  return nullptr;
}
id KCUAAXAttribute(AXUIElementRef, CFStringRef) { return nil; }
CGRect KCUAAXBounds(AXUIElementRef) { return CGRectZero; }
void KCUABeginScopedFocus(const KCUATargetRef &, const KCUAOp &) {}
void KCUAEndScopedFocus(void) {}
void KCUAGhostHide(void) {}
void KCUAGhostPoint(CGPoint) {}
NSDictionary *KCUAScopedFocusRecoveryRecord(void) { return @{}; }
void KCUARecoverScopedFocus(NSDictionary *) {}
void KCUAStampWindowEvent(CGEventRef event, const KCUATargetRef &target) {
  // 用测试字段标识经过同一窗口定向适配器的事件，拦截器不会向 GUI 投递。
  CGEventSetIntegerValueField(event, kCGEventSourceUserData, target->windowId);
}

static void verifyPair(CGEventType down, CGEventType up) {
  assert(deliveries.size() == 2);
  assert(deliveries.front().type == down && deliveries.back().type == up);
  for (const auto &delivery : deliveries) {
    assert(delivery.pid == original->pid);
    assert(delivery.window == original->windowId &&
           "release must carry the same window scope as press");
  }
  deliveries.clear();
}

static KCUAOp operation(void) {
  auto op = std::make_shared<KCUAOperation>();
  op->peer = @"fixture-peer";
  op->session = @"fixture-session";
  return op;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    original = std::make_shared<KCUATarget>();
    original->pid = 101;
    original->birth = @"fixture-birth";
    original->windowId = 17;
    original->bounds = CGRectMake(100, 200, 400, 500);
    currentBounds = original->bounds;
    if (argc == 3) {
      KCUAInputInitialize([NSString stringWithUTF8String:argv[2]]);
      if (!strcmp(argv[1], "crash-down"))
        crashAt = kCGEventKeyDown;
      if (!strcmp(argv[1], "crash-up"))
        crashAt = kCGEventKeyUp;
      auto input = operation();
      if (!strcmp(argv[1], "unresolved")) {
        @try {
          KCUAInput(@"press_key", @{@"text" : @"b"}, input);
          assert(false);
        } @catch (NSException *error) {
          assert([error.name isEqual:@"cleanup_incomplete"]);
        }
        KCUAInputCleanup(input);
        assert(deliveries.empty());
        puts("interrupted release stayed unresolved");
        return 0;
      }
      KCUAInput(@"press_key", @{@"text" : @"b"}, input);
      assert(!strcmp(argv[1], "recover") && deliveries.size() == 3);
      assert(deliveries.front().type == kCGEventKeyUp &&
             deliveries.front().window == original->windowId);
      deliveries.erase(deliveries.begin());
      verifyPair(kCGEventKeyDown, kCGEventKeyUp);
      puts("crash recovery released the original window before new input");
      return 0;
    }
    auto op = operation();
    KCUAInput(@"press_key", @{@"text" : @"a"}, op);
    KCUAInputCleanup(op);
    verifyPair(kCGEventKeyDown, kCGEventKeyUp);

    op = cancelOnDown = operation();
    @try {
      KCUAInput(@"hold_key", @{@"text" : @"a", @"duration" : @1}, op);
      assert(false);
    } @catch (NSException *error) {
      assert([error.name isEqual:@"cancelled"]);
    }
    KCUAInputCleanup(op);
    verifyPair(kCGEventKeyDown, kCGEventKeyUp);

    op = cancelOnDown = operation();
    @try {
      KCUAInput(
          @"drag", @{
            @"from" : @{@"x" : @130, @"y" : @240},
            @"to" : @{@"x" : @180, @"y" : @260}
          },
          op);
      assert(false);
    } @catch (NSException *error) {
      assert([error.name isEqual:@"cancelled"]);
    }
    currentBounds = CGRectOffset(original->bounds, 70, 80);
    KCUAInputCleanup(op);
    assert(CGPointEqualToPoint(deliveries.back().point, CGPointMake(200, 320)));
    verifyPair(kCGEventLeftMouseDown, kCGEventLeftMouseUp);

    op = cancelOnDown = operation();
    @try {
      KCUAInput(@"hold_key", @{@"text" : @"a", @"duration" : @1}, op);
      assert(false);
    } @catch (NSException *error) {
      assert([error.name isEqual:@"cancelled"]);
    }
    targetGone = true;
    KCUAInputCleanup(op);
    assert(deliveries.size() == 1 && deliveries[0].type == kCGEventKeyDown);
    puts("targeted normal and cancelled release passed");
  }
}
