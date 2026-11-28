// 元素重定位回归：观察后元素身份变了，必须在窗口里重新找到唯一匹配才能继续动作。
// 重定位与元素登记都是 observation.mm 的文件内静态函数，夹具把该源文件并入同一编译单元，
// 经真实的登记与解析入口驱动；窗口服务与 AX 读取按其它夹具的做法在链接期替换。
#include "../native/macos/observation.mm"
#include <cassert>

@interface FixtureNode : NSObject
@property (strong) NSString *role;
@property (strong) NSString *title;
@property (strong) NSString *identifier;
@property (strong) NSMutableArray<FixtureNode *> *children;
@end
@implementation FixtureNode
+ (instancetype)nodeWithRole:(NSString *)role
                       title:(NSString *)title
                  identifier:(NSString *)identifier {
  auto node = [FixtureNode new];
  node.role = role;
  node.title = title;
  node.identifier = identifier;
  node.children = [NSMutableArray array];
  return node;
}
@end

static FixtureNode *fixtureNode(AXUIElementRef element) {
  id object = (__bridge id)element;
  return [object isKindOfClass:FixtureNode.class] ? object : nil;
}
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
  else if (CFEqual(attribute, kAXIdentifierAttribute))
    result = node.identifier;
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
extern "C" CFArrayRef CGWindowListCopyWindowInfo(CGWindowListOption option,
                                                 CGWindowID relativeTo) {
  (void)option;
  (void)relativeTo;
  return (CFArrayRef)CFBridgingRetain(@[ @{
    (__bridge id)kCGWindowNumber : @17,
    (__bridge id)kCGWindowOwnerPID : @4242,
    (__bridge id)kCGWindowLayer : @0
  } ]);
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

static const pid_t fixturePID = 4242;
static KCUAOp operation(void) {
  auto op = std::make_shared<KCUAOperation>();
  op->peer = @"fixture-peer";
  op->session = @"fixture-session";
  return op;
}
// 观察整棵树并登记元素。flat[0] 是窗口，flat[1] 是内容区，之后是内容区的子节点，
// 按数组顺序登记，到 2048 个为止。
static NSArray *observe(FixtureNode *window) {
  auto target = std::make_shared<KCUATarget>();
  target->pid = fixturePID;
  target->windowId = 17;
  target->desktopEpoch = 0;
  target->birth = KCUAProcessBirth(fixturePID);
  target->bounds = CGRectMake(100, 200, 400, 300);
  target->window = (AXUIElementRef)CFRetain((__bridge CFTypeRef)window);
  bool truncated = false;
  NSArray *flat = observeElements(
      target, @{@"tree_shown_to_model" : @YES}, operation(), &truncated);
  assert(truncated == (flat.count == 2048));
  return flat;
}
static NSException *resolve(NSString *token) {
  @try {
    KCUATargetRef owner;
    KCUAResolveElement(@{ @"native" : token }, operation(), &owner);
  } @catch (NSException *error) {
    return error;
  }
  return nil;
}
static NSException *expectUnavailable(NSString *token, NSString *reason) {
  auto start = std::chrono::steady_clock::now();
  NSException *error = resolve(token);
  assert(error && [error.name isEqual:@"element_unavailable"]);
  assert([error.reason containsString:reason]);
  // 重定位在任何输入之前失败，回执必须明确没有发送。
  assert([error.userInfo[@"action_sent"] isEqual:@NO]);
  assert(std::chrono::steady_clock::now() - start <
         std::chrono::seconds(2));
  return error;
}
static FixtureNode *windowWithChildren(NSArray<FixtureNode *> *children) {
  auto content =
      [FixtureNode nodeWithRole:@"AXGroup" title:@"Content" identifier:nil];
  content.children = [children mutableCopy];
  auto window =
      [FixtureNode nodeWithRole:@"AXWindow" title:@"Window" identifier:nil];
  window.children = [NSMutableArray arrayWithObject:content];
  return window;
}
static FixtureNode *field(NSString *title, NSString *identifier) {
  return [FixtureNode nodeWithRole:@"AXTextField" title:title
                        identifier:identifier];
}
static NSMutableArray<FixtureNode *> *fillers(NSUInteger count) {
  auto nodes = [NSMutableArray array];
  for (NSUInteger index = 0; index < count; index++)
    [nodes addObject:[FixtureNode
                        nodeWithRole:@"AXStaticText"
                                title:[NSString stringWithFormat:@"row-%lu",
                                                           (unsigned long)index]
                           identifier:nil]];
  return nodes;
}
static NSUInteger countTitle(NSArray *flat, NSString *title) {
  NSUInteger count = 0;
  for (NSDictionary *entry in flat)
    if ([entry[@"title"] isEqual:title])
      ++count;
  return count;
}

int main(void) {
  @autoreleasepool {
    // 窗口里的节点数超过遍历上限。重定位从数组的另一头开始搜：先遇到数组末尾的 first，
    // 开头的 late 还没看到搜索就到了上限。原先会直接返回 first，动作落到并不唯一的控件上；
    // 现在搜索没有走完就按元素不可用处理。
    auto observed = field(@"observed", @"target-field");
    auto children = [NSMutableArray arrayWithObject:field(@"late", @"target-field")];
    [children addObjectsFromArray:fillers(3000)];
    [children addObject:field(@"first", @"target-field")];
    [children insertObject:observed atIndex:0];
    auto flat = observe(windowWithChildren(children));
    assert([flat[2][@"title"] isEqual:@"observed"] &&
           [flat[3][@"title"] isEqual:@"late"]);
    NSString *observedToken = flat[2][@"native"];
    // 被观察的元素换了标识，按原标识重新定位。
    observed.identifier = @"renamed";
    auto truncated = expectUnavailable(observedToken,
                                       @"could not finish searching");
    assert([truncated.userInfo[@"dispatch_status"] isEqual:@"not_sent"]);

    // 没有标识符的控件按标题和位置识别，截断时同样不能下结论。
    auto titled = field(@"Row", nil);
    auto titledChildren = [NSMutableArray arrayWithObject:field(@"Row", nil)];
    [titledChildren addObjectsFromArray:fillers(3000)];
    [titledChildren addObject:field(@"Row", nil)];
    [titledChildren insertObject:titled atIndex:0];
    flat = observe(windowWithChildren(titledChildren));
    titled.title = @"moved";
    expectUnavailable(flat[2][@"native"], @"could not finish searching");

    // 搜索走完且只有一个匹配：正常重新定位到它。
    auto unique = field(@"unique", @"unique-field");
    auto uniqueObserved = field(@"unique-observed", @"unique-field");
    flat = observe(windowWithChildren(@[ uniqueObserved, unique ]));
    uniqueObserved.identifier = @"renamed";
    @try {
      KCUATargetRef owner;
      AXUIElementRef element =
          KCUAResolveElement(@{ @"native" : flat[2][@"native"] }, operation(),
                             &owner);
      assert(element == (__bridge AXUIElementRef)unique);
      assert(owner->pid == fixturePID);
    } @catch (NSException *) {
      assert(false && "a unique match must resolve");
    }
    // 登记已改指向重新定位到的元素；它再变化时窗口里已经没有匹配。
    unique.identifier = @"renamed-again";
    expectUnavailable(flat[2][@"native"], @"cannot be uniquely");

    // 搜索走完但有两个匹配：仍然拒绝。重定位从数组末尾往前搜，先遇到 other，再遇到 other-late。
    auto otherObserved = field(@"other-observed", @"shared-field");
    flat = observe(windowWithChildren(@[ otherObserved, field(@"other", @"shared-field"),
                                        field(@"other-late", @"shared-field") ]));
    otherObserved.identifier = @"renamed";
    expectUnavailable(flat[2][@"native"], @"matched multiple controls");

    puts("element refetch resolves only a unique match from a completed "
         "search");
  }
}
