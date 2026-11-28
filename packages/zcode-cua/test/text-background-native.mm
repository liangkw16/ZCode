#import "../native/macos/automation.h"
#include <ApplicationServices/ApplicationServices.h>
#include <cassert>
#include <map>
#include <unistd.h>
#include <objc/runtime.h>
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
static NSUInteger flushes;
// 目标应用里带焦点的文本框。value 是应用里的真实值，visible 是辅助功能读到的值：live 时两者
// 一致（AppKit）；否则要等应用发出待发的更新（后台 Chromium），也就是 KCUAAXHitTest 之后。
// readable 为 NO 时读不到值。accepts 为 NO 时按键进不了输入框（只读、校验拒绝等）。
// losesValue 时第一次输入之后它不再是值为字符串的控件（按键被当成了快捷键）。
static struct {
  BOOL live, readable, accepts, losesValue;
  NSString *value, *visible;
} field;
// 应用级焦点元素：NSNull 表示读不到。fieldElement 是落点控件对应的元素，previousElement 是
// “上一个焦点控件”的元素。
static id focusedElement;
static id fieldElement, previousElement;
// 应用报告的焦点元素可能还是上一次更新时的那个：4 号节点是“上一个焦点控件”，flipAfterFlush
// 表示第几次更新请求之后焦点报告才换成真正的落点（0 表示一直不变）。
static NSString *previousValue;
static NSInteger flipAfterFlush;
static BOOL positioned;
// 窗口树里的节点：用不同的 pid 造出不同的 AX 元素，按 pid 查它各属性的应答。
static NSMutableDictionary<NSNumber *, NSDictionary *> *elementScript;
static NSMutableArray *elementRefs;

extern "C" void CGEventPostToPid(pid_t pid, CGEventRef event) {
  (void)pid;
  UniChar units[8] = {};
  UniCharCount count = 0;
  CGEventKeyboardGetUnicodeString(event, 8, &count, units);
  CGKeyCode key = (CGKeyCode)CGEventGetIntegerValueField(
      event, kCGKeyboardEventKeycode);
  CGEventFlags flags = CGEventGetFlags(event);
  NSString *text = [NSString stringWithCharacters:units length:count];
  deliveries.push_back({CGEventGetType(event), key, flags, text});
  if (CGEventGetType(event) != kCGEventKeyDown)
    return;
  if (key == 9 && (flags & kCGEventFlagMaskCommand)) {
    // ⌘V 送达即模拟目标应用读取剪贴板，原因见 paste-transaction-native.mm。
    consumedOnDelivery =
        [[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"payload"];
    text = [fixtureBoard stringForType:NSPasteboardTypeString] ?: @"";
  } else if (!text.length)
    // Return、Tab 这类纯键位在输入框里插入的字符。
    text = key == 36 ? @"\n" : key == 48 ? @"\t" : @"";
  if (!field.accepts || !text.length)
    return;
  field.value = [field.value stringByAppendingString:text];
  if (field.live)
    field.visible = field.value;
  if (field.losesValue)
    field.readable = NO;
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
AXUIElementRef KCUAResolveElement(NSDictionary *, const KCUAOp &,
                                  KCUATargetRef *owner) {
  assert(positioned);
  *owner = original;
  return (AXUIElementRef)CFRetain((__bridge CFTypeRef)fieldElement);
}
// 模拟 macOS 27.2.1 的行为：对不是辅助功能元素（非 __NSCFType 类链）的对象调用 AX API 会
// SIGTRAP（M2 上的两次 Helper 崩溃就是这么来的；27.2.0 只返回错误码，复现不了）。
static BOOL fixtureIsAXElement(id object) {
  for (Class cls = object_getClass(object); cls; cls = class_getSuperclass(cls))
    if ([NSStringFromClass(cls) isEqualToString:@"__NSCFType"])
      return YES;
  return NO;
}
extern "C" AXError AXUIElementSetMessagingTimeout(AXUIElementRef element,
                                                  float timeout) {
  (void)timeout;
  if (!fixtureIsAXElement((__bridge id)element)) {
    fprintf(stderr, "fixture trap: AX call on %s\n",
            NSStringFromClass([(__bridge id)element class]).UTF8String);
    abort();
  }
  return kAXErrorSuccess;
}
extern "C" AXError AXUIElementSetAttributeValue(AXUIElementRef element,
                                               CFStringRef attribute,
                                               CFTypeRef value) {
  (void)value;
  assert(element == (__bridge AXUIElementRef)fieldElement &&
         CFEqual(attribute, kAXFocusedAttribute));
  return kAXErrorSuccess;
}
static AXUIElementRef node(NSInteger number) {
  return AXUIElementCreateApplication((pid_t)(1000 + number));
}
id KCUAAXAttribute(AXUIElementRef element, CFStringRef attribute) {
  assert(element);
  pid_t pid = 0;
  AXUIElementGetPid(element, &pid);
  NSString *name = (__bridge NSString *)attribute;
  if (pid != original->pid) {
    if ([name isEqual:(__bridge NSString *)kAXValueAttribute])
      return pid == 1004 ? previousValue
                         : (field.readable ? field.visible : NSNull.null);
    return elementScript[@(pid)][name];
  }
  // 应用级只问焦点元素。
  assert(CFEqual(attribute, kAXFocusedUIElementAttribute));
  return focusedElement;
}
CGRect KCUAAXBounds(AXUIElementRef) { return CGRectMake(10, 20, 30, 40); }
void KCUAAXHitTest(pid_t pid, CGPoint point) {
  assert(pid == original->pid);
  assert(point.x == 25 && point.y == 40);
  flushes += 1;
  field.visible = field.value;
  if (flipAfterFlush && flushes >= flipAfterFlush)
    focusedElement = fieldElement;
}
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
  if (positioned)
    params[@"focus_native"] = @"tok";
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
// visible 为 nil 表示读不到落点的值；它与 value 不同模拟应用里有待发的更新。
// withPositioning：输入带定位元素；stalePrevious：焦点报告先指向 4 号控件，staleAfter 次
// 更新请求之后才换成落点。
static void scenario(id focused, NSString *visible, NSString *value, BOOL live,
                     BOOL accepts, BOOL withPositioning = NO,
                     NSString *stalePrevious = nil, NSInteger staleAfter = 0) {
  focusedElement = stalePrevious ? previousElement : focused;
  previousValue = stalePrevious;
  flipAfterFlush = stalePrevious ? staleAfter : 0;
  positioned = withPositioning;
  field = {live, visible != nil, accepts, NO, [value copy], [visible copy]};
  flushes = 0;
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
static NSException *notInserted(NSString *text,
                                NSString *method = @"type_text_to_app") {
  auto op = operation();
  NSMutableDictionary *params = [@{ @"text" : text } mutableCopy];
  if (positioned)
    params[@"focus_native"] = @"tok";
  NSException *error = capture(^{
    KCUAInput(method, params, op);
  });
  KCUAInputCleanup(op);
  assertNotInserted(error);
  return error;
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
    fieldElement = (__bridge id)node(1);
    previousElement = (__bridge id)node(4);
    elementScript = [NSMutableDictionary dictionary];
    elementRefs = [NSMutableArray array];
    for (AXUIElementRef item :
         { original->window, (__bridge AXUIElementRef)fieldElement, node(2),
           node(3), (__bridge AXUIElementRef)previousElement })
      [elementRefs addObject:(__bridge id)item];
    fixtureBoard = [NSPasteboard pasteboardWithUniqueName];
    method_setImplementation(
        class_getClassMethod(NSPasteboard.class, @selector(generalPasteboard)),
        imp_implementationWithBlock(^id(id) { return fixtureBoard; }));
    id focusedId = fieldElement;

    // 读不到落点：不核对，只报告派发。每个 Unicode 标量一对不带修饰键的按键：emoji 的代理对
    // 整对发出；\r\n 合成一次 Return，\t 是 Tab。剪贴板不被接管。
    scenario(NSNull.null, nil, @"", NO, NO);
    assert([type(@"ab你\r\nx\ty😀") isEqual:accepted]);
    assert([shape() isEqual:@"0:a 0:b 0:你 36: 0:x 48: 0:y 0:😀"]);
    assertPairs();
    assert(flushes == 0);
    // 孤立的代理项不是一个字符：按 U+FFFD 发出去，不把半个代理对送进应用。
    scenario(NSNull.null, nil, @"", NO, NO);
    assert([type([NSString stringWithCharacters:(UniChar[]){ 0xD83D } length:1]) isEqual:accepted]);
    assert([shape() isEqual:@"0:\uFFFD"]);
    assert([[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"user-old"]);

    // 首字进了输入框：值变了，其余字符照发。
    scenario(focusedId, @"", @"", YES, YES);
    assert([type(@"hello") isEqual:accepted]);
    assert([shape() isEqual:@"0:h 0:e 0:l 0:l 0:o"]);
    assertPairs();

    // 首字没进输入框：停在这里，如实报告没有落地，不把余下按键连发出去。
    scenario(focusedId, @"", @"", YES, NO);
    notInserted(@"hello");
    assert([shape() isEqual:@"0:h"]);
    // 值没变就算没落地，即使它本来就包含这个字符。
    scenario(focusedId, @"h", @"h", YES, NO);
    notInserted(@"hello");
    assert([shape() isEqual:@"0:h"]);

    // 首字是 Return：没有值可核对，直接发完。
    scenario(focusedId, @"", @"", YES, YES);
    assert([type(@"\nab") isEqual:accepted]);
    assert([shape() isEqual:@"36: 0:a 0:b"]);

    // 后台 Chromium 式的应用：按键改了值，但要等应用发出待发的更新才读得到。基线取更新
    // 之后的值，首字之后要再请求一次；首字确实进了输入框才算落地。
    scenario(focusedId, @"seed", @"seedxy", NO, YES);
    assert([type(@"hello") isEqual:accepted]);
    assert([shape() isEqual:@"0:h 0:e 0:l 0:l 0:o"]);
    assert(flushes >= 2);
    // 请求让值变了一次，那不是首字落地的证据：输入框不接收按键就停在这里。
    scenario(focusedId, @"seed", @"seedxy", NO, NO);
    notInserted(@"hello");
    assert([shape() isEqual:@"0:h"]);
    assert(flushes >= 1);
    scenario(focusedId, @"seed", @"seed", NO, NO);
    notInserted(@"hello");
    assert([shape() isEqual:@"0:h"]);

    // 首字之后读不到值（按键被当成了快捷键，焦点离开文本控件）：不算落地。
    scenario(focusedId, @"", @"", YES, YES);
    field.losesValue = YES;
    notInserted(@"hello");
    assert([shape() isEqual:@"0:h"]);

    // 焦点报告滞后（一）：输入带定位元素。应用报告的焦点元素先是别的控件，第二次更新请求之后
    // 才换成落点。基线和核对都读定位的元素：输入框不接收按键就停在这里，不被别的控件的值
    // 骗过去。
    scenario(focusedId, @"ro", @"ro", YES, NO, YES, @"", 2);
    notInserted(@"hello");
    assert([shape() isEqual:@"0:h"]);
    scenario(focusedId, @"", @"", YES, YES, YES, @"seed", 2);
    assert([type(@"hello") isEqual:accepted]);
    assert([shape() isEqual:@"0:h 0:e 0:l 0:l 0:o"]);

    // 焦点报告滞后（二）：没有定位元素。基线取自别的控件，核对途中焦点元素变了：以它重新取
    // 基线，下一个字符再核对。输入框不接收按键时多发了一个字符就停。
    scenario(focusedId, @"ro", @"ro", YES, NO, NO, @"", 2);
    notInserted(@"hello");
    assert([shape() isEqual:@"0:h 0:e"]);
    // 输入框能输入：字符都留下，回执 accepted。
    scenario(focusedId, @"", @"", YES, YES, NO, @"", 2);
    assert([type(@"hello") isEqual:accepted]);
    assert([shape() isEqual:@"0:h 0:e 0:l 0:l 0:o"]);

    // 应用级没有焦点元素时，在目标窗口的树里找带焦点标记、值为字符串的元素；
    // 0 号节点没有焦点，访问顺序是先子后孙，第 3 号才命中。更新请求落在找到的元素上。
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
    scenario(NSNull.null, @"seed", @"seedok", NO, YES);
    assert([type(@"ok") isEqual:accepted]);
    assert([shape() isEqual:@"0:o 0:k"]);
    assert(flushes >= 2);
    scenario(NSNull.null, @"seed", @"seed", NO, NO);
    notInserted(@"ok");
    assert([shape() isEqual:@"0:o"]);
    // children 里混入非元素条目（字符串）：跳过它，继续找到后面的真元素。旧实现把它当元素
    // 传给 AX API，按 27.2.1 的行为直接 trap（上面桩成 abort，等价复现 M2 的两次崩溃）。
    elementScript[@1000] = @{
      (NSString *)kAXChildrenAttribute
          : @[ @"junk-string", (__bridge id)node(3) ]
    };
    elementScript[@1003] = @{
      (NSString *)kAXFocusedAttribute : @YES,
      (NSString *)kAXChildrenAttribute : @[]
    };
    scenario(NSNull.null, @"seed", @"seedxy", NO, YES);
    assert([type(@"ok") isEqual:accepted]);
    assert([shape() isEqual:@"0:o 0:k"]);
    assert(flushes >= 2);
    elementScript[@1000] = @{
      (NSString *)kAXChildrenAttribute
          : @[ (__bridge id)node(2), (__bridge id)node(3) ]
    };

    // 树里没有带焦点标记的元素：不核对，只报告派发。
    elementScript[@1003] = @{
      (NSString *)kAXFocusedAttribute : @NO,
      (NSString *)kAXChildrenAttribute : @[]
    };
    scenario(NSNull.null, @"seed", @"seed", NO, YES);
    assert([type(@"ok") isEqual:accepted]);
    assert([shape() isEqual:@"0:o 0:k"]);
    assert(flushes == 0);

    // 中途取消：已发出的按键算已派发，后面的不再发。
    scenario(NSNull.null, nil, @"", NO, NO);
    cancelAfter = 4;
    auto op = operation();
    NSException *error = capture(^{
      KCUAInput(@"type_text_to_app", @{ @"text" : @"abcdef" }, op);
    });
    KCUAInputCleanup(op);
    assert(error && [error.name isEqual:@"cancelled"]);
    assert([error.userInfo[@"action_sent"] isEqual:@YES]);
    assert([error.userInfo[@"dispatch_status"] isEqual:@"possibly_sent"]);
    assert(deliveries.size() == 4);

    // 超长和控制字符在派发前拒绝。
    scenario(NSNull.null, nil, @"", NO, NO);
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
    scenario(focusedId, @"", @"", YES, YES);
    assert([type(@"ab") isEqual:accepted]);
    assert([shape() isEqual:@"9:"]);
    assert(deliveries[0].flags & kCGEventFlagMaskCommand);
    assert([[fixtureBoard stringForType:NSPasteboardTypeString] isEqual:@"user-old"]);
    original->pid = 101;
    method_setImplementation(frontmost, previous);

    // paste 工具必须是粘贴：不在前台也不改成按键，没有落地时如实报告。
    scenario(focusedId, @"", @"", YES, NO);
    notInserted(@"ab", @"paste");
    assert([shape() isEqual:@"9:"]);
    // 带格式的 type 同样只能是粘贴。
    scenario(NSNull.null, nil, @"", NO, NO);
    assert([type(@"ab", @"type_text_to_app", @"md") isEqual:accepted]);
    assert([shape() isEqual:@"9:"]);

    for (id item in elementRefs)
      CFRelease((__bridge CFTypeRef)item);
    [fixtureBoard releaseGlobally];
    puts("background typing sends one unicode key pair per scalar and gates on the first character");
  }
  return 0;
}
