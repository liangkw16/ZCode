#import "../native/macos/automation.h"
#include <ApplicationServices/ApplicationServices.h>
#include <objc/runtime.h>
#include <cassert>
#include <map>
#include <unistd.h>
#include <vector>

// 后台 type：目标不在前台时 ⌘V 不会被当作菜单快捷键（见 text-landing-native.mm），同一通道里
// 能进输入框的是不带修饰键、带字符的按键（Chrome 158 与 AppKit 实测）。这里按产品入口
// KCUAInput 驱动，核对派发方式的选择、逐字符按键的形状、首字落地核对和各项拒绝。
struct Delivery {
  CGEventType type;
  CGKeyCode key;
  CGEventFlags flags;
  NSString *text;
};
static std::vector<Delivery> deliveries;
static KCUATargetRef original;
static NSPasteboard *fixtureBoard;
static BOOL consumedOnDelivery;
static NSInteger cancelAfter = -1;
// 应用级焦点元素与它的值按读取顺序出队，用尽后重复最后一项；NSNull 表示读不到。
static NSMutableArray *focusedScript, *valueScript;
static NSUInteger focusedReads, valueReads;
// 窗口树里的节点：用不同的 pid 造出不同的 AX 元素，按 pid 查它各属性的应答。
static NSMutableDictionary<NSNumber *, NSDictionary *> *elementScript;
// 节点的值也可以按读取顺序出队；没有脚本的节点每次都返回同一个值。
static NSMutableDictionary<NSNumber *, NSMutableArray *> *elementValueScript;
static std::map<pid_t, NSUInteger> elementValueReads;
static NSMutableArray *elementRefs;

extern "C" void CGEventPostToPid(pid_t pid, CGEventRef event) {
  (void)pid;
  UniChar units[8] = {};
  UniCharCount count = 0;
  CGEventKeyboardGetUnicodeString(event, 8, &count, units);
  deliveries.push_back({CGEventGetType(event),
                        (CGKeyCode)CGEventGetIntegerValueField(
                            event, kCGKeyboardEventKeycode),
                        CGEventGetFlags(event),
                        [NSString stringWithCharacters:units length:count]});
  // ⌘V 送达即模拟目标应用读取剪贴板，原因见 paste-transaction-native.mm。
  if (fixtureBoard && CGEventGetType(event) == kCGEventKeyDown)
    consumedOnDelivery =
        [[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"payload"];
}
NSString *KCUAProcessBirth(pid_t pid) {
  return pid == original->pid ? original->birth : nil;
}
NSString *KCUAGeneration(void) { return @"background-type-test"; }
uint64_t KCUADesktopEpoch(void) { return 0; }
NSString *KCUADisplayTopologyFingerprint(void) { return @"fixture-topology"; }
void KCUACheck(const KCUAOp &op) {
  if (op->cancelled ||
      (cancelAfter >= 0 && (NSInteger)deliveries.size() >= cancelAfter)) {
    op->cancelled = true;
    // 与协调器同一口径：已经派发过的按键按 possibly_sent 报告。
    KCUAFail(@"cancelled", @"fixture cancellation",
             @{ @"action_sent" : @(op->dispatched.load()),
                @"dispatch_status" : op->dispatched.load() ? @"possibly_sent" : @"not_sent" });
  }
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
static AXUIElementRef node(NSInteger number) {
  return AXUIElementCreateApplication((pid_t)(1000 + number));
}
id KCUAAXAttribute(AXUIElementRef element, CFStringRef attribute) {
  assert(element);
  pid_t pid = 0;
  AXUIElementGetPid(element, &pid);
  NSString *name = (__bridge NSString *)attribute;
  if (pid == 1001) {
    // 应用级焦点元素的值按读取顺序出队。
    assert(CFEqual(attribute, kAXValueAttribute));
    id value = valueScript[MIN(valueReads, valueScript.count - 1)];
    valueReads += 1;
    return value;
  }
  if (pid != original->pid) {
    if ([name isEqual:(__bridge NSString *)kAXValueAttribute] &&
        elementValueScript[@(pid)]) {
      NSMutableArray *script = elementValueScript[@(pid)];
      NSUInteger &reads = elementValueReads[pid];
      id value = script[MIN(reads, script.count - 1)];
      reads += 1;
      return value;
    }
    return elementScript[@(pid)][name];
  }
  // 应用级只问焦点元素。
  assert(CFEqual(attribute, kAXFocusedUIElementAttribute));
  id focused = focusedScript[MIN(focusedReads, focusedScript.count - 1)];
  focusedReads += 1;
  return focused;
}
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
static NSException *capture(void (^body)(void)) {
  @try {
    body();
  } @catch (NSException *error) {
    return error;
  }
  return nil;
}
static KCUAOp operation(void) {
  auto op = std::make_shared<KCUAOperation>();
  op->peer = @"fixture-peer";
  op->session = @"fixture-session";
  return op;
}
static NSDictionary *type(NSString *text, NSString *method = @"type_text_to_app",
                          NSString *format = nil) {
  auto op = operation();
  NSMutableDictionary *params = [@{ @"text" : text } mutableCopy];
  if (format)
    params[@"format"] = format;
  NSDictionary *result = KCUAInput(method, params, op);
  KCUAInputCleanup(op);
  return result;
}
// 按键落下的序列，形如 0:a 36: 48:。Return、Tab 这类纯键位的字符由系统按键盘布局补上，不比对。
static NSString *shape(void) {
  NSMutableArray *parts = [NSMutableArray array];
  for (const auto &item : deliveries)
    if (item.type == kCGEventKeyDown)
      [parts addObject:[NSString stringWithFormat:@"%d:%@", item.key, item.key ? @"" : item.text]];
  return [parts componentsJoinedByString:@" "];
}
static void assertPairs(void) {
  assert(deliveries.size() % 2 == 0);
  for (size_t index = 0; index < deliveries.size(); index += 2) {
    const auto &down = deliveries[index];
    const auto &up = deliveries[index + 1];
    assert(down.type == kCGEventKeyDown && up.type == kCGEventKeyUp);
    assert(down.key == up.key && down.flags == 0 && up.flags == 0);
    assert([down.text isEqual:up.text]);
  }
}
static void scenario(id focused, NSArray *values) {
  focusedScript = [NSMutableArray arrayWithObject:focused];
  valueScript = [NSMutableArray arrayWithArray:values];
  focusedReads = valueReads = 0;
  elementValueReads.clear();
  deliveries.clear();
  cancelAfter = -1;
  consumedOnDelivery = NO;
  [fixtureBoard clearContents];
  [fixtureBoard setString:@"user-old" forType:NSPasteboardTypeString];
}
static void assertNotInserted(NSException *error) {
  assert(error && [error.name isEqual:@"foreground_required"]);
  assert([error.userInfo[@"action_sent"] isEqual:@YES]);
  assert([error.userInfo[@"dispatch_status"] isEqual:@"possibly_sent"]);
  assert([error.userInfo[@"reason_code"] isEqual:@"text_insertion_not_observed"]);
}
static void assertRejected(NSException *error) {
  assert(error && [error.name isEqual:@"invalid_request"]);
  assert([error.userInfo[@"action_sent"] isEqual:@NO]);
  assert(deliveries.empty());
}
static NSDictionary *accepted = @{ @"action_sent" : @YES, @"dispatch_status" : @"accepted" };

int main(void) {
  @autoreleasepool {
    original = std::make_shared<KCUATarget>();
    original->pid = 101;
    original->birth = @"fixture-birth";
    original->windowId = 17;
    original->bounds = CGRectMake(100, 200, 400, 500);
    original->window = node(0);
    AXUIElementRef focusedElement = node(1);
    elementScript = [NSMutableDictionary dictionary];
    elementValueScript = [NSMutableDictionary dictionary];
    elementRefs = [NSMutableArray array];
    for (AXUIElementRef item : { original->window, focusedElement, node(2), node(3) })
      [elementRefs addObject:(__bridge id)item];
    fixtureBoard = [NSPasteboard pasteboardWithUniqueName];
    method_setImplementation(
        class_getClassMethod(NSPasteboard.class, @selector(generalPasteboard)),
        imp_implementationWithBlock(^id(id) { return fixtureBoard; }));
    id focusedId = (__bridge id)focusedElement;

    // 读不到落点：不核对，只报告派发。每个 Unicode 标量一对不带修饰键的按键：emoji 的代理对
    // 整对发出；\r\n 合成一次 Return，\t 是 Tab。剪贴板不被接管。
    scenario(NSNull.null, @[]);
    assert([type(@"ab你\r\nx\ty😀") isEqual:accepted]);
    assert([shape() isEqual:@"0:a 0:b 0:你 36: 0:x 48: 0:y 0:😀"]);
    assertPairs();
    // 孤立的代理项不是一个字符：按 U+FFFD 发出去，不把半个代理对送进应用。
    scenario(NSNull.null, @[]);
    assert([type([NSString stringWithCharacters:(UniChar[]){ 0xD83D } length:1]) isEqual:accepted]);
    assert([shape() isEqual:@"0:\uFFFD"]);
    assert([[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"user-old"]);

    // 首字进了输入框：值变了，其余字符照发。
    scenario(focusedId, @[ @"", @"h" ]);
    assert([type(@"hello") isEqual:accepted]);
    assert([shape() isEqual:@"0:h 0:e 0:l 0:l 0:o"]);
    assertPairs();

    // 首字没进输入框：停在这里，如实报告没有落地，不把余下按键连发出去。
    scenario(focusedId, @[ @"", @"" ]);
    auto op = operation();
    assertNotInserted(capture(^{
      KCUAInput(@"type_text_to_app", @{ @"text" : @"hello" }, op);
    }));
    KCUAInputCleanup(op);
    assert([shape() isEqual:@"0:h"]);
    // 值没变就算没落地，即使它本来就包含这个字符。
    scenario(focusedId, @[ @"h", @"h" ]);
    op = operation();
    assertNotInserted(capture(^{
      KCUAInput(@"type_text_to_app", @{ @"text" : @"hello" }, op);
    }));
    KCUAInputCleanup(op);
    assert([shape() isEqual:@"0:h"]);

    // 首字是 Return：没有值可核对，直接发完。
    scenario(focusedId, @[ @"" ]);
    assert([type(@"\nab") isEqual:accepted]);
    assert([shape() isEqual:@"36: 0:a 0:b"]);

    // 应用级没有焦点元素时，在目标窗口的树里找带焦点标记、值为字符串的元素；
    // 0 号节点没有焦点，访问顺序是先子后孙，第 3 号才命中。
    elementScript[@1000] = @{
      (NSString *)kAXChildrenAttribute : @[ (__bridge id)node(2), (__bridge id)node(3) ]
    };
    elementScript[@1002] = @{
      (NSString *)kAXFocusedAttribute : @NO,
      (NSString *)kAXChildrenAttribute : @[]
    };
    elementScript[@1003] = @{
      (NSString *)kAXFocusedAttribute : @YES,
      (NSString *)kAXChildrenAttribute : @[]
    };
    elementValueScript[@1003] = [NSMutableArray arrayWithArray:@[ @"seed", @"seeda" ]];
    scenario(NSNull.null, @[]);
    assert([type(@"ok") isEqual:accepted]);
    assert([shape() isEqual:@"0:o 0:k"]);
    elementValueScript[@1003] = [NSMutableArray arrayWithArray:@[ @"seed", @"seed" ]];
    scenario(NSNull.null, @[]);
    op = operation();
    assertNotInserted(capture(^{
      KCUAInput(@"type_text_to_app", @{ @"text" : @"ok" }, op);
    }));
    KCUAInputCleanup(op);
    assert([shape() isEqual:@"0:o"]);
    // 树里没有带焦点标记的元素：不核对，只报告派发。
    elementScript[@1003] = @{
      (NSString *)kAXFocusedAttribute : @NO,
      (NSString *)kAXChildrenAttribute : @[]
    };
    scenario(NSNull.null, @[]);
    assert([type(@"ok") isEqual:accepted]);
    assert([shape() isEqual:@"0:o 0:k"]);

    // 中途取消：已发出的按键算已派发，后面的不再发。
    scenario(NSNull.null, @[]);
    cancelAfter = 4;
    op = operation();
    NSException *error = capture(^{
      KCUAInput(@"type_text_to_app", @{ @"text" : @"abcdef" }, op);
    });
    KCUAInputCleanup(op);
    assert(error && [error.name isEqual:@"cancelled"]);
    assert([error.userInfo[@"action_sent"] isEqual:@YES]);
    assert([error.userInfo[@"dispatch_status"] isEqual:@"possibly_sent"]);
    assert(deliveries.size() == 4);

    // 超长和控制字符在派发前拒绝。
    scenario(NSNull.null, @[]);
    assertRejected(capture(^{
      type([@"a" stringByPaddingToLength:2049 withString:@"a" startingAtIndex:0]);
    }));
    assertRejected(capture(^{
      type(@"a\b");
    }));
    assert([[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"user-old"]);

    // 前台目标仍走粘贴事务：只有一对 ⌘V，按粘贴规则核对落地。
    Method frontmost =
        class_getInstanceMethod(NSWorkspace.class, @selector(frontmostApplication));
    IMP previous = method_getImplementation(frontmost);
    method_setImplementation(frontmost, imp_implementationWithBlock(^id(id) {
      return [NSRunningApplication currentApplication];
    }));
    original->pid = getpid();
    scenario(focusedId, @[ @"", @"ab" ]);
    assert([type(@"ab") isEqual:accepted]);
    assert([shape() isEqual:@"9:"]);
    assert(deliveries[0].flags & kCGEventFlagMaskCommand);
    assert([[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"user-old"]);
    original->pid = 101;
    method_setImplementation(frontmost, previous);

    // paste 工具必须是粘贴：不在前台也不改成按键，没有落地时如实报告。
    scenario(focusedId, @[ @"", @"" ]);
    op = operation();
    assertNotInserted(capture(^{
      KCUAInput(@"paste", @{ @"text" : @"ab", @"format" : @"text" }, op);
    }));
    KCUAInputCleanup(op);
    assert([shape() isEqual:@"9:"]);
    // 带格式的 type 同样只能是粘贴。
    scenario(NSNull.null, @[]);
    assert([type(@"ab", @"type_text_to_app", @"md") isEqual:accepted]);
    assert([shape() isEqual:@"9:"]);

    for (id item in elementRefs)
      CFRelease((__bridge CFTypeRef)item);
    [fixtureBoard releaseGlobally];
    puts("background typing sends one unicode key pair per scalar and gates on the first character");
  }
  return 0;
}
