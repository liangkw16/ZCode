#import "../native/macos/automation.h"
#include <ApplicationServices/ApplicationServices.h>
#include <objc/runtime.h>
#include <cassert>
#include <unistd.h>
#include <vector>

// 粘贴事务：读取剪贴板快照期间若有人写入新内容，必须放弃本次粘贴且不覆盖用户的内容；
// 正常路径在清理后恢复接管前的剪贴板。
struct Delivery {
  CGEventType type;
  CGEventFlags flags;
};
static std::vector<Delivery> deliveries;
static KCUATargetRef original;
static BOOL wroteDuringSnapshot;
static IMP originalItems;
static NSPasteboard *fixtureBoard;
static BOOL consumedOnDelivery;

extern "C" void CGEventPostToPid(pid_t pid, CGEventRef event) {
  (void)pid;
  deliveries.push_back({CGEventGetType(event), CGEventGetFlags(event)});
  // ⌘V 送达即模拟目标应用读取剪贴板。读取必须和事务在同一线程：NSPasteboard 按名字返回的是
  // 同一个缓存对象，另一个线程同时读写会在 AppKit 的类型缓存里竞争（并行时 NSRangeException
  // 或 SIGSEGV）。
  if (fixtureBoard && CGEventGetType(event) == kCGEventKeyDown)
    consumedOnDelivery =
        [[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"payload"];
}
NSString *KCUAProcessBirth(pid_t pid) { return pid == original->pid ? original->birth : nil; }
NSString *KCUAGeneration(void) { return @"paste-test"; }
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
AXUIElementRef KCUAResolveElement(NSDictionary *, const KCUAOp &, KCUATargetRef *) {
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
  CGEventSetIntegerValueField(event, kCGEventSourceUserData, target->windowId);
}

static NSArray *itemsWithConcurrentWrite(NSPasteboard *self, SEL selector) {
  // 第一次读取快照时模拟用户复制了新内容。
  if (!wroteDuringSnapshot) {
    wroteDuringSnapshot = YES;
    [self clearContents];
    [self setString:@"user-new" forType:NSPasteboardTypeString];
  }
  return ((NSArray *(*)(id, SEL))originalItems)(self, selector);
}
static KCUAOp operation(void) {
  auto op = std::make_shared<KCUAOperation>();
  op->peer = @"fixture-peer";
  op->session = @"fixture-session";
  return op;
}
static void seed(NSPasteboard *board, NSString *value) {
  [board clearContents];
  [board setString:value forType:NSPasteboardTypeString];
}
static NSException *capture(void (^body)(void)) {
  @try {
    body();
  } @catch (NSException *error) {
    return error;
  }
  return nil;
}

int main(void) {
  @autoreleasepool {
    original = std::make_shared<KCUATarget>();
    original->pid = 101;
    original->birth = @"fixture-birth";
    original->windowId = 17;
    original->bounds = CGRectMake(100, 200, 400, 500);
    NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];

    seed(board, @"user-old");
    Method items = class_getInstanceMethod(NSPasteboard.class,
                                           @selector(pasteboardItems));
    originalItems = method_getImplementation(items);
    wroteDuringSnapshot = NO;
    method_setImplementation(items, (IMP)itemsWithConcurrentWrite);
    auto op = operation();
    NSException *error = capture(^{
      KCUAPasteText(board, original, @"payload", @"text", op);
    });
    method_setImplementation(items, originalItems);
    assert(error && [error.name isEqual:@"action_unavailable"]);
    assert([error.userInfo[@"action_sent"] isEqual:@NO] &&
           [error.userInfo[@"dispatch_status"] isEqual:@"not_sent"]);
    assert([[board stringForType:NSPasteboardTypeString] isEqual:@"user-new"]);
    KCUAInputCleanup(op);
    assert([[board stringForType:NSPasteboardTypeString] isEqual:@"user-new"]);
    assert(deliveries.empty());

    seed(board, @"user-old");
    op = operation();
    deliveries.clear();
    fixtureBoard = board;
    consumedOnDelivery = NO;
    KCUAPasteText(board, original, @"payload", @"text", op);
    fixtureBoard = nil;
    assert(consumedOnDelivery && "fixture never observed the pasted payload");
    assert([[board stringForType:NSPasteboardTypeString] isEqual:@"payload"]);
    assert(deliveries.size() == 2 && deliveries[0].type == kCGEventKeyDown &&
           deliveries[1].type == kCGEventKeyUp);
    assert((deliveries[0].flags & kCGEventFlagMaskCommand) != 0);
    KCUAInputCleanup(op);
    assert([[board stringForType:NSPasteboardTypeString] isEqual:@"user-old"]);

    [board releaseGlobally];
    puts("paste transaction keeps concurrent clipboard writes and restores its own takeover");
  }
}
