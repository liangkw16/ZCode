// 观察网页内容前先请应用发出待发的更新：后台 Chromium 不随按键推送网页内容的值，直接遍历会读到
// 输入之前的值。夹具把 observation.mm 并入同一编译单元（遍历是文件内静态函数），窗口服务与 AX
// 读取按其它夹具的做法在链接期替换。
#include "../native/macos/observation.mm"
#include <cassert>

@interface FixtureNode : NSObject
@property (strong) NSString *role;
@property (strong) NSString *title;
@property (strong) NSString *value;
@property (strong) NSMutableArray<FixtureNode *> *children;
@end
@implementation FixtureNode
+ (instancetype)nodeWithRole:(NSString *)role title:(NSString *)title {
  auto node = [FixtureNode new];
  node.role = role;
  node.title = title;
  node.children = [NSMutableArray array];
  return node;
}
@end

static FixtureNode *fixtureNode(AXUIElementRef element) {
  id object = (__bridge id)element;
  return [object isKindOfClass:FixtureNode.class] ? object : nil;
}
static NSInteger hitTests;
static CGPoint hitPoint;
// 应用处理命中测试时才发出来的值。
static NSString *pendingValue;
static FixtureNode *typedInto;
extern "C" AXError AXUIElementCopyAttributeValue(AXUIElementRef element,
                                                 CFStringRef attribute,
                                                 CFTypeRef *value) {
  FixtureNode *node = fixtureNode(element);
  if (!node)
    return kAXErrorFailure;
  id result = nil;
  if (CFEqual(attribute, kAXRoleAttribute))
    result = node.role;
  else if (CFEqual(attribute, kAXTitleAttribute))
    result = node.title;
  else if (CFEqual(attribute, kAXValueAttribute))
    result = node.value;
  else if (CFEqual(attribute, kAXChildrenAttribute))
    result = node.children;
  else if (CFEqual(attribute, kAXPositionAttribute)) {
    CGPoint point = CGPointMake(100, 200);
    result = CFBridgingRelease(AXValueCreate(kAXValueTypeCGPoint, &point));
  } else if (CFEqual(attribute, kAXSizeAttribute)) {
    CGSize size = CGSizeMake(400, 300);
    result = CFBridgingRelease(AXValueCreate(kAXValueTypeCGSize, &size));
  } else if (CFEqual(attribute, kAXEnabledAttribute))
    result = @YES;
  else if (CFEqual(attribute, kAXFocusedAttribute) ||
           CFEqual(attribute, kAXSelectedAttribute))
    result = @NO;
  if (!result)
    return kAXErrorFailure;
  *value = CFBridgingRetain(result);
  return kAXErrorSuccess;
}
extern "C" AXError AXUIElementCopyActionNames(AXUIElementRef element,
                                              CFArrayRef *names) {
  (void)element;
  *names = (CFArrayRef)CFBridgingRetain([NSMutableArray array]);
  return kAXErrorSuccess;
}
extern "C" AXError AXUIElementCopyElementAtPosition(AXUIElementRef element,
                                                     float x, float y,
                                                     AXUIElementRef *hit) {
  assert(element == nullptr || fixtureNode(element) == nullptr);
  hitTests += 1;
  hitPoint = CGPointMake(x, y);
  typedInto.value = pendingValue;
  *hit = (AXUIElementRef)CFBridgingRetain(typedInto);
  return kAXErrorSuccess;
}
KCUAOp KCUACurrentOperation(void) { return nullptr; }
void KCUACheck(const KCUAOp &op) {
  if (op->cancelled)
    KCUAFail(@"cancelled", @"fixture cancellation");
}
void KCUARequireAccessibility(void) {}
void KCUARequireDesktop(void) {}
uint64_t KCUADesktopEpoch(void) { return 0; }
NSString *KCUAProcessBirth(pid_t pid) {
  return [NSString stringWithFormat:@"%d:1:1", pid];
}
void KCUAPresentationCapture(const KCUATargetRef &, NSDictionary *) {}
NSDictionary *KCUACapture(const KCUATargetRef &, const KCUAOp &) { return @{}; }
bool KCUASessionHasDrained(NSString *, NSString *) { return false; }
NSString *KCUADesktopAvailability(void) { return @"unlocked"; }

static NSArray *observe(FixtureNode *window) {
  auto target = std::make_shared<KCUATarget>();
  target->pid = 4242;
  target->windowId = 17;
  target->birth = KCUAProcessBirth(target->pid);
  target->bounds = CGRectMake(100, 200, 400, 300);
  target->window = (AXUIElementRef)CFRetain((__bridge CFTypeRef)window);
  bool truncated = false;
  auto op = std::make_shared<KCUAOperation>();
  op->peer = @"fixture-peer";
  op->session = @"fixture-session";
  return observeElements(target, @{@"tree_shown_to_model" : @YES}, op,
                         &truncated);
}
static FixtureNode *window(FixtureNode *content) {
  auto window =
      [FixtureNode nodeWithRole:@"AXWindow" title:@"Window"];
  window.children = [NSMutableArray arrayWithObject:content];
  return window;
}

int main(void) {
  @autoreleasepool {
    // 网页内容：根是 AXWebArea，里面有一个输入框。值要等应用处理一次命中测试才发得出来。
    auto page = [FixtureNode nodeWithRole:@"AXWebArea" title:@"page"];
    typedInto = [FixtureNode nodeWithRole:@"AXTextField" title:@"field"];
    typedInto.value = @"before";
    page.children = [NSMutableArray arrayWithObject:typedInto];
    pendingValue = @"before typed";
    auto flat = observe(window(page));
    // 命中测试落在网页内容的中心，输入框读到的是更新之后的值。
    assert(hitTests == 1);
    assert(CGPointEqualToPoint(hitPoint, CGPointMake(300, 350)));
    assert(flat.count == 3);
    assert([flat[1][@"role"] isEqual:@"AXWebArea"]);
    assert([flat[2][@"value"] isEqual:@"before typed"]);
    assert([flat[2][@"title"] isEqual:@"field"]);

    // 没有网页内容的窗口（原生应用）不做命中测试。
    hitTests = 0;
    auto native =
        [FixtureNode nodeWithRole:@"AXGroup" title:@"Content"];
    native.children = [NSMutableArray arrayWithObject:typedInto];
    flat = observe(window(native));
    assert(hitTests == 0);
    assert(flat.count == 3);

    puts("observing web content requests pending updates before reading "
         "values");
  }
  return 0;
}
