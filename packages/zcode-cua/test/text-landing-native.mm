#import "../native/macos/automation.h"
#include <ApplicationServices/ApplicationServices.h>
#include <cassert>
#include <unistd.h>
#include <vector>

// 粘贴回执：目标进程读取了剪贴板不等于文本进了输入框。能读到落点元素的值时以值为准，
// 读不到时才沿用"剪贴板被读取"这一条证据。
//
// 修复前的现场（M2 原生夹具、本机 keylab）：AppKit 应用不在前台时不处理 ⌘V 菜单快捷键，
// 按键送达窗口、剪贴板也被读取，输入框没有变化，回执却是 accepted。
struct Delivery {
  CGEventType type;
  CGEventFlags flags;
};
static std::vector<Delivery> deliveries;
static KCUATargetRef original;
static NSPasteboard *fixtureBoard;
static BOOL consumedOnDelivery;
// landingValue 每次先取焦点元素、再取它的值：两段脚本各按调用顺序出队，用尽后重复最后一项。
static NSMutableArray *focusedScript;
static NSMutableArray *valueScript;
static NSInteger focusedReads, valueReads;
static AXUIElementRef focusedElement;

extern "C" void CGEventPostToPid(pid_t pid, CGEventRef event) {
  (void)pid;
  deliveries.push_back({CGEventGetType(event), CGEventGetFlags(event)});
  // ⌘V 送达即模拟目标应用读取剪贴板；与事务同线程，原因见 paste-transaction-native.mm。
  // HTML 事务只提供 HTML 类型，要按它声明的类型读取才会触发数据提供者。
  if (fixtureBoard && CGEventGetType(event) == kCGEventKeyDown)
    consumedOnDelivery =
        [[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"payload"] ||
        [fixtureBoard dataForType:NSPasteboardTypeHTML].length > 0;
}
NSString *KCUAProcessBirth(pid_t pid) { return pid == original->pid ? original->birth : nil; }
NSString *KCUAGeneration(void) { return @"landing-test"; }
uint64_t KCUADesktopEpoch(void) { return 0; }
NSString *KCUADisplayTopologyFingerprint(void) { return @"fixture-topology"; }
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
id KCUAAXAttribute(AXUIElementRef element, CFStringRef attribute) {
  assert(element);
  NSMutableArray *script = nullptr;
  NSInteger *reads = nullptr;
  if (CFEqual(attribute, kAXFocusedUIElementAttribute)) {
    script = focusedScript;
    reads = &focusedReads;
  } else {
    assert(CFEqual(attribute, kAXValueAttribute));
    script = valueScript;
    reads = &valueReads;
  }
  id value = script[MIN(*reads, (NSInteger)script.count - 1)];
  *reads += 1;
  return [value isKindOfClass:NSNull.class] ? nil : value;
}
CGRect KCUAAXBounds(AXUIElementRef) { return CGRectZero; }
// 粘贴路径不请求更新：值在前台窗口里是实时的。
void KCUAAXHitTest(pid_t, CGPoint) { assert(false); }
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
static void seed(NSPasteboard *board, NSString *value) {
  [board clearContents];
  [board setString:value forType:NSPasteboardTypeString];
}
// focused=nil 表示应用没有焦点元素；values 是落点元素按读取顺序的值，NSNull 表示读不到。
static void scenario(NSPasteboard *board, BOOL focused, NSArray *values,
                     BOOL consumed, NSString *format, NSString *text) {
  focusedScript = [NSMutableArray arrayWithObject:focused ? (__bridge id)focusedElement : NSNull.null];
  valueScript = [NSMutableArray array];
  for (id value in values)
    [valueScript addObject:value ?: NSNull.null];
  focusedReads = valueReads = 0;
  fixtureBoard = consumed ? board : nil;
  consumedOnDelivery = NO;
  deliveries.clear();
  seed(board, @"user-old");
}
static NSException *capture(void (^body)(void)) {
  @try {
    body();
  } @catch (NSException *error) {
    return error;
  }
  return nil;
}
static void assertNotInserted(NSException *error) {
  assert(error && [error.name isEqual:@"foreground_required"]);
  assert([error.userInfo[@"action_sent"] isEqual:@YES]);
  assert([error.userInfo[@"dispatch_status"] isEqual:@"possibly_sent"]);
  assert([error.userInfo[@"reason_code"] isEqual:@"text_insertion_not_observed"]);
}

int main(void) {
  @autoreleasepool {
    original = std::make_shared<KCUATarget>();
    original->pid = 101;
    original->birth = @"fixture-birth";
    original->windowId = 17;
    original->bounds = CGRectMake(100, 200, 400, 500);
    focusedElement = AXUIElementCreateApplication(101);
    NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];

    // 值变了：落地，回执 accepted。剪贴板没被读取也不算失败——值是更直接的证据。
    scenario(board, YES, @[ @"user-old", @"user-oldpayload" ], NO, @"text", @"payload");
    auto op = operation();
    KCUAPasteText(board, original, @"payload", @"text", op);
    KCUAInputCleanup(op);
    assert(deliveries.size() == 2);
    // 整段文本替换了同内容的选区：值没变但包含文本，同样算落地。
    scenario(board, YES, @[ @"payload", @"payload" ], YES, @"text", @"payload");
    op = operation();
    KCUAPasteText(board, original, @"payload", @"text", op);
    KCUAInputCleanup(op);

    // 剪贴板被读取、值却没变：修复前的现场，必须如实报告没有落地。
    scenario(board, YES, @[ @"", @"" ], YES, @"text", @"payload");
    op = operation();
    assertNotInserted(capture(^{
      KCUAPasteText(board, original, @"payload", @"text", op);
    }));
    KCUAInputCleanup(op);
    assert([[board stringForType:NSPasteboardTypeString] isEqual:@"user-old"]);
    // 剪贴板一直没被读取、值也一直没变：同样是没落地，给出可操作的指引而不是旧的那句。
    scenario(board, YES, @[ @"", @"" ], NO, @"text", @"payload");
    op = operation();
    assertNotInserted(capture(^{
      KCUAPasteText(board, original, @"payload", @"text", op);
    }));
    KCUAInputCleanup(op);

    // 读不到落点：沿用旧口径，剪贴板被读取即算送达。
    scenario(board, NO, @[], YES, @"text", @"payload");
    op = operation();
    KCUAPasteText(board, original, @"payload", @"text", op);
    KCUAInputCleanup(op);
    // HTML 的源码与粘贴后的内容不可比，即使值可读也只看剪贴板证据。
    scenario(board, YES, @[ @"", @"" ], YES, @"html", @"<b>payload</b>");
    op = operation();
    KCUAPasteText(board, original, @"<b>payload</b>", @"html", op);
    KCUAInputCleanup(op);
    // 读不到落点、剪贴板也没被读取：保留原来的失败。
    scenario(board, NO, @[], NO, @"text", @"payload");
    op = operation();
    NSException *error = capture(^{
      KCUAPasteText(board, original, @"payload", @"text", op);
    });
    assert(error && [error.name isEqual:@"action_unavailable"]);
    assert(error.userInfo[@"reason_code"] == nil);
    KCUAInputCleanup(op);

    CFRelease(focusedElement);
    [board releaseGlobally];
    puts("paste receipt reports a focused field that never received the text");
  }
}
