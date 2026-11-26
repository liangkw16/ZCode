#import "automation.h"
#import "text-contract.h"
#include <chrono>
#include <cmath>
#include <fcntl.h>
#include <map>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

enum class HoldPhase { Prepared, Held, Releasing, Released };
struct HeldInput {
  KCUATargetRef target;
  CGKeyCode key;
  CGEventFlags flags;
  bool mouse;
  CGMouseButton button;
  CGPoint windowPoint;
  NSInteger clickCount = 1;
  HoldPhase phase = HoldPhase::Prepared;
  bool dispatched = false;
};
static std::vector<HeldInput> holds;
static NSArray *savedClipboard;
static NSPasteboard *ownedBoard;
static NSInteger ownedClipboardCount = -1;
static NSString *safetyPath;
static bool recoveryPending = false;
static std::map<std::string, bool> activationPolicy;
@interface KCUAPasteProvider : NSObject <NSPasteboardItemDataProvider>
@property(atomic, strong) NSDictionary<NSPasteboardType, NSData *> *payload;
@property(atomic) BOOL dispatched;
@property(atomic) BOOL provided;
@end
@implementation KCUAPasteProvider
- (void)pasteboard:(NSPasteboard *)pasteboard
                  item:(NSPasteboardItem *)item
    provideDataForType:(NSPasteboardType)type {
  (void)pasteboard;
  NSData *data = self.payload[type];
  if (data) {
    [item setData:data forType:type];
    if (self.dispatched)
      self.provided = YES;
  }
}
@end
static void clearJournal(void) {
  if (unlink(safetyPath.fileSystemRepresentation) != 0 && errno != ENOENT)
    KCUAFail(@"cleanup_incomplete", @"Cannot clear input-safety record");
}
static void writeJournal(NSDictionary *journal) {
  NSData *data = [NSPropertyListSerialization
      dataWithPropertyList:journal
                    format:NSPropertyListBinaryFormat_v1_0
                   options:0
                     error:nil];
  NSString *temporary =
      [safetyPath stringByAppendingFormat:@".%@.tmp", [NSUUID UUID].UUIDString];
  int fd = open(temporary.fileSystemRepresentation,
                O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
  if (fd < 0)
    KCUAFail(@"cleanup_incomplete", @"Cannot create input-safety record");
  ssize_t bytes = write(fd, data.bytes, data.length);
  int synced = fsync(fd);
  close(fd);
  if (!data || bytes != (ssize_t)data.length || synced != 0 ||
      rename(temporary.fileSystemRepresentation,
             safetyPath.fileSystemRepresentation) != 0) {
    unlink(temporary.fileSystemRepresentation);
    KCUAFail(@"cleanup_incomplete", @"Cannot persist input-safety record");
  }
}
void KCUAPersistInputSafety(void) {
  if (!safetyPath || recoveryPending)
    return;
  NSDictionary *focus = KCUAScopedFocusRecoveryRecord();
  NSMutableArray *records = [NSMutableArray array];
  for (const auto &hold : holds) {
    if (hold.phase == HoldPhase::Released)
      continue;
    [records addObject:@{
      @"pid" : @(hold.target->pid),
      @"birth" : hold.target->birth,
      @"window_id" : @(hold.target->windowId),
      @"key" : @(hold.key),
      @"flags" : @(hold.flags),
      @"mouse" : @(hold.mouse),
      @"button" : @(hold.button),
      @"x" : @(hold.windowPoint.x),
      @"y" : @(hold.windowPoint.y),
      @"click_count" : @(hold.clickCount),
      @"phase" : @((int)hold.phase)
    }];
  }
  if (!records.count && !savedClipboard && !focus.count) {
    clearJournal();
    return;
  }
  writeJournal(@{
    @"schema" : @2,
    @"helper_pid" : @(getpid()),
    @"helper_birth" : KCUAProcessBirth(getpid()),
    @"holds" : records,
    @"clipboard" : savedClipboard ?: @[],
    @"clipboard_count" : @(ownedClipboardCount),
    @"synthetic_focus" : focus,
    @"helper_generation" : KCUAGeneration() ?: @""
  });
}
static void restoreClipboard(NSArray *saved, NSInteger ownerCount) {
  NSPasteboard *board = ownedBoard ?: NSPasteboard.generalPasteboard;
  if (!saved || board.changeCount != ownerCount)
    return;
  NSMutableArray *items = [NSMutableArray array];
  for (NSDictionary *record in saved) {
    NSPasteboardItem *item = [NSPasteboardItem new];
    for (NSString *type in record)
      [item setData:record[type] forType:type];
    [items addObject:item];
  }
  [board clearContents];
  if (items.count)
    [board writeObjects:items];
}
static void releaseToWindow(const HeldInput &hold, bool normal,
                            void (^recordPhase)(HoldPhase)) {
  auto target = KCUAResolveInputReleaseTarget(
      hold.target->pid, hold.target->birth, hold.target->windowId);
  if (!target)
    return;
  if (hold.phase == HoldPhase::Releasing)
    KCUAFail(@"cleanup_incomplete",
             @"The previous release may have been delivered. Close the original window, then observe again.",
             @{@"reason_code" : @"input_recovery_release_uncertain"});
  if (!hold.mouse)
    KCUARequireInputKeyWindow(target, true);
  CGEventRef event = nullptr;
  if (hold.mouse) {
    CGPoint point = CGPointMake(target->bounds.origin.x + hold.windowPoint.x,
                                target->bounds.origin.y + hold.windowPoint.y);
    CGEventType up = hold.button == kCGMouseButtonLeft ? kCGEventLeftMouseUp
                     : hold.button == kCGMouseButtonRight
                         ? kCGEventRightMouseUp
                         : kCGEventOtherMouseUp;
    event = CGEventCreateMouseEvent(nullptr, up, point, hold.button);
    if (event)
      CGEventSetIntegerValueField(event, kCGMouseEventClickState,
                                  hold.clickCount);
  } else {
    event = CGEventCreateKeyboardEvent(nullptr, hold.key, false);
  }
  if (!event)
    KCUAFail(@"cleanup_incomplete", @"Cannot construct a scoped input release");
  @try {
    CGEventSetFlags(event, normal && hold.mouse ? hold.flags : 0);
    KCUAStampWindowEvent(event, target);
    recordPhase(HoldPhase::Releasing);
    @try {
      if (!hold.mouse)
        KCUARequireInputKeyWindow(target, true);
    } @catch (NSException *error) {
      // 此处尚未投递 up，焦点在写盘期间改变时保留待恢复状态。
      recordPhase(HoldPhase::Held);
      @throw;
    }
    CGEventPostToPid(target->pid, event);
  } @finally {
    CFRelease(event);
  }
}
void KCUAInputInitialize(NSString *runtimeDir) {
  safetyPath =
      [runtimeDir stringByAppendingPathComponent:@"input-safety.plist"];
  // 健康和预检先上线，恢复事件由调度器取得租约后的首条输入触发。
  recoveryPending = true;
}
static void recoverInputSafety(void) {
  if (!recoveryPending)
    return;
  struct stat st;
  if (lstat(safetyPath.fileSystemRepresentation, &st) != 0) {
    if (errno != ENOENT)
      KCUAFail(@"cleanup_incomplete", @"Cannot inspect input recovery record");
    recoveryPending = false;
    return;
  }
  if (!S_ISREG(st.st_mode) || S_ISLNK(st.st_mode) || st.st_uid != getuid() ||
      (st.st_mode & 0077) || st.st_size > 10 * 1024 * 1024)
    KCUAFail(@"not_authorized", @"Unsafe input recovery record");
  int fd = open(safetyPath.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0)
    KCUAFail(@"cleanup_incomplete", @"Input recovery record cannot be opened");
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)st.st_size];
  ssize_t bytes = read(fd, data.mutableBytes, data.length);
  close(fd);
  if (bytes != st.st_size)
    KCUAFail(@"cleanup_incomplete", @"Input recovery record is incomplete");
  NSDictionary *record =
      [NSPropertyListSerialization propertyListWithData:data
                                                options:NSPropertyListImmutable
                                                 format:nil
                                                  error:nil];
  if (![record isKindOfClass:NSDictionary.class] ||
      ![@[ @1, @2 ] containsObject:record[@"schema"] ?: NSNull.null] ||
      ![record[@"holds"] isKindOfClass:NSArray.class])
    KCUAFail(@"cleanup_incomplete", @"Input recovery record is malformed");
  pid_t previous = [record[@"helper_pid"] intValue];
  NSString *birth = KCUAProcessBirth(previous);
  if (birth && [birth isEqual:record[@"helper_birth"]])
    KCUAFail(@"controller_busy", @"Previous native input owner is still alive");
  NSMutableDictionary *journal = [record mutableCopy];
  NSMutableArray *remaining = [record[@"holds"] mutableCopy];
  journal[@"holds"] = remaining;
  while (remaining.count) {
    NSDictionary *entry = remaining.lastObject;
    if (![entry isKindOfClass:NSDictionary.class] ||
        ![entry[@"birth"] isKindOfClass:NSString.class])
      KCUAFail(@"cleanup_incomplete", @"Invalid saved input target");
    bool legacy = [record[@"schema"] intValue] == 1;
    id phase = entry[@"phase"];
    if (!legacy && ![@[ @0, @1, @2 ] containsObject:phase ?: NSNull.null])
      KCUAFail(@"cleanup_incomplete", @"Invalid saved input phase");
    if (legacy || [phase intValue] != (int)HoldPhase::Prepared) {
      auto target = std::make_shared<KCUATarget>();
      target->pid = [entry[@"pid"] intValue];
      target->birth = entry[@"birth"];
      target->windowId = [entry[@"window_id"] unsignedIntValue];
      HeldInput hold{
          target,
          (CGKeyCode)[entry[@"key"] unsignedIntValue],
          (CGEventFlags)[entry[@"flags"] unsignedLongLongValue],
          [entry[@"mouse"] boolValue] == YES,
          (CGMouseButton)[entry[@"button"] unsignedIntValue],
          CGPointMake([entry[@"x"] doubleValue], [entry[@"y"] doubleValue]),
          [entry[@"click_count"] integerValue],
          legacy ? HoldPhase::Held : (HoldPhase)[phase intValue]};
      @try {
        releaseToWindow(hold, false, ^(HoldPhase phase) {
          NSMutableDictionary *releasing = [entry mutableCopy];
          releasing[@"phase"] = @((int)phase);
          [remaining replaceObjectAtIndex:remaining.count - 1
                               withObject:releasing];
          writeJournal(journal);
        });
      } @catch (NSException *error) {
        NSString *reason = error.userInfo[@"reason_code"];
        if ([error.name isEqual:@"cleanup_incomplete"] &&
            [@[ @"input_recovery_focus_required", @"input_recovery_release_uncertain",
                @"input_recovery_target_unverified" ] containsObject:reason ?: @""]) {
          // 旧动作仍待清理，本次新动作尚未开始。保留日志与观察服务，避免每次写入都触发换代。
          KCUAFail(@"action_unavailable", error.reason, @{
            @"reason_code" : reason, @"action_sent" : @NO,
            @"dispatch_status" : @"not_sent"
          });
        }
        @throw;
      }
    }
    [remaining removeLastObject];
    writeJournal(journal);
  }
  KCUARecoverScopedFocus(record[@"synthetic_focus"]);
  restoreClipboard(record[@"clipboard"],
                   [record[@"clipboard_count"] integerValue]);
  clearJournal();
  recoveryPending = false;
}
static void post(CGEventRef event, const KCUATargetRef &target,
                 const KCUAOp &op) {
  if (!event)
    KCUAFail(@"action_unavailable",
             @"Could not construct target-scoped input event");
  @try {
    KCUACheck(op);
    KCUAValidateTarget(target, true);
    KCUABeginScopedFocus(target, op);
    KCUAStampWindowEvent(event, target);
    if (!holds.empty()) {
      auto &hold = holds.back();
      hold.phase = HoldPhase::Held;
      if (hold.mouse) {
        CGPoint point = CGEventGetLocation(event);
        hold.windowPoint = CGPointMake(point.x - target->bounds.origin.x,
                                       point.y - target->bounds.origin.y);
      }
      KCUAPersistInputSafety();
    }
    if (CGEventGetType(event) != kCGEventKeyDown &&
        CGEventGetType(event) != kCGEventKeyUp &&
        CGEventGetType(event) != kCGEventFlagsChanged)
      KCUAGhostPoint(CGEventGetLocation(event));
    KCUACheck(op);
    KCUARequireDesktop();
    if (CGEventGetType(event) == kCGEventKeyDown)
      KCUARequireInputKeyWindow(target, false);
    if (!holds.empty())
      holds.back().dispatched = true;
    op->dispatched = true;
    CGEventPostToPid(target->pid, event);
  } @finally {
    CFRelease(event);
  }
}
static void keyDown(const KCUATargetRef &target, KCUAKeyChord chord,
                    const KCUAOp &op) {
  holds.push_back(
      {target, chord.key, chord.flags, false, kCGMouseButtonLeft, CGPointZero});
  KCUAPersistInputSafety();
  CGEventRef event = CGEventCreateKeyboardEvent(nullptr, chord.key, true);
  CGEventSetFlags(event, chord.flags);
  post(event, target, op);
}
static void releaseLastInput(bool normal) {
  auto *hold = &holds.back();
  if (hold->dispatched && hold->phase != HoldPhase::Released) {
    releaseToWindow(*hold, normal, ^(HoldPhase phase) {
      auto previous = hold->phase;
      hold->phase = phase;
      @try {
        KCUAPersistInputSafety();
      } @catch (NSException *error) {
        hold->phase = previous;
        @throw;
      }
    });
  }
  hold->phase = HoldPhase::Released;
  KCUAPersistInputSafety();
  holds.pop_back();
}
static void forgetLanding(void);
void KCUAInputCleanup(const KCUAOp &op) {
  forgetLanding();
  @try {
    while (!holds.empty())
      releaseLastInput(false);
  } @finally {
    @try {
      KCUAEndScopedFocus();
    } @finally {
      restoreClipboard(savedClipboard, ownedClipboardCount);
      savedClipboard = nil;
      ownedBoard = nil;
      ownedClipboardCount = -1;
      KCUAPersistInputSafety();
      if (op->cancelled)
        KCUAGhostHide();
    }
  }
}
// 粘贴与后台逐字符输入的落点是应用里带焦点的文本控件。landingElement 返回这个元素，找不到
// 返回 nil；landingValue 返回它当前的值，读不到（没有这样的控件、不支持 AXValue、不是字符串）
// 返回 nil。带定位元素的输入（focus_native / click_native）以定位的元素为落点；其余情况先取
// 应用的焦点元素，取不到时在目标窗口的辅助功能树里找带焦点标记、值为字符串的节点，查找有
// 节点数和时间上限。定位的元素和树里找到的元素按目标记到本次操作结束：落地核对会反复读值，
// 不必每次重走一遍树。
// 经 KCUAAXAttribute 读取，回归用例按同一入口替换。
static constexpr NSInteger KCUALandingSearchLimit = 240;
static constexpr auto KCUALandingSearchBudget = std::chrono::milliseconds(150);
static KCUATargetRef landingOwner;
static id landingKnown;
// 基线是从哪个元素读的。没有定位元素时应用的焦点报告可能滞后（见 typeBackgroundKeys），
// 核对途中要拿它和当前读到的元素比。
static id landingBaseline;
static void forgetLanding(void) {
  landingKnown = nil;
  landingBaseline = nil;
  landingOwner.reset();
}
static bool ownsLanding(const KCUATargetRef &target) {
  return landingKnown && landingOwner &&
         landingOwner->pid == target->pid &&
         landingOwner->windowId == target->windowId;
}
static void rememberLanding(id element, const KCUATargetRef &target) {
  landingKnown = element;
  landingOwner = target;
}
// 同一个辅助功能元素每次取到的是不同的引用，按 CFEqual 比较。
static bool sameLanding(id a, id b) {
  return a && b && CFEqual((__bridge CFTypeRef)a, (__bridge CFTypeRef)b);
}
static id appFocusedLanding(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app, 0.25);
  id focused = KCUAAXAttribute(app, kAXFocusedUIElementAttribute);
  CFRelease(app);
  if (focused && CFGetTypeID((__bridge CFTypeRef)focused) == AXUIElementGetTypeID())
    return focused;
  return nil;
}
static id searchLanding(const KCUATargetRef &target) {
  if (!target->window)
    return nil;
  auto deadline = std::chrono::steady_clock::now() + KCUALandingSearchBudget;
  // 深度优先：输入控件通常离窗口不远，宽度优先会先扫完整条工具栏。
  NSMutableArray *pending = [NSMutableArray arrayWithObject:(__bridge id)target->window];
  for (NSInteger visited = 0;
       pending.count && visited < KCUALandingSearchLimit &&
       std::chrono::steady_clock::now() < deadline;
       visited++) {
    AXUIElementRef node = (__bridge AXUIElementRef)pending.lastObject;
    [pending removeLastObject];
    AXUIElementSetMessagingTimeout(node, 0.25);
    if ([KCUAAXAttribute(node, kAXFocusedAttribute)
             isEqual:(__bridge id)kCFBooleanTrue]) {
      id value = KCUAAXAttribute(node, kAXValueAttribute);
      if ([value isKindOfClass:NSString.class]) {
        rememberLanding((__bridge id)node, target);
        return (__bridge id)node;
      }
    }
    id children = KCUAAXAttribute(node, kAXChildrenAttribute);
    NSArray *list = [children isKindOfClass:NSArray.class] ? children : @[];
    for (NSInteger index = (NSInteger)list.count - 1; index >= 0; index--)
      if (list[index])
        [pending addObject:list[index]];
  }
  return nil;
}
static id landingElement(const KCUATargetRef &target) {
  if (ownsLanding(target))
    return landingKnown;
  if (id focused = appFocusedLanding(target->pid))
    return focused;
  return searchLanding(target);
}
static NSString *elementValue(id element) {
  if (!element)
    return nil;
  id value =
      KCUAAXAttribute((__bridge AXUIElementRef)element, kAXValueAttribute);
  return [value isKindOfClass:NSString.class] ? value : nil;
}
static NSString *landingValue(const KCUATargetRef &target) {
  return elementValue(landingElement(target));
}
// 修复原因：落地核对要读到应用当前的值。后台 Chromium 不随按键推送输入控件值的更新，值停在
// 上一次它自己发出待发更新的时候（给控件设辅助功能焦点会触发），直接读会把旧值当成基线，或者
// 读不到刚输入的首字，核对就不再是落地的证据（构建机 Chrome 158 实测：每次操作结束后读到的
// 多行框的值都是输入之前的）。Chromium 处理命中测试时会把待发的更新一并发出来：对应用元素
// 在落点中心做一次命中测试，实测 12–17 毫秒后值与页面一致，光标不动；只读的属性请求、对
// 控件自身做命中测试都不会触发。请求只读，AppKit 的值本来就是实时的，不受影响。
static void refreshLanding(id element, pid_t pid) {
  if (!element)
    return;
  CGRect bounds = KCUAAXBounds((__bridge AXUIElementRef)element);
  if (!CGRectIsEmpty(bounds))
    KCUAAXHitTest(pid,
                  CGPointMake(CGRectGetMidX(bounds), CGRectGetMidY(bounds)));
}
static void pauseLanding(void) {
  // worker 线程的 run loop 没有源，CFRunLoopRunInMode 会立刻返回；这里要真的等一等。
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
}
// 基线：发出更新请求后等值不再因它变化，并把读基线的元素记在 landingBaseline。值变了说明
// 待发的更新已到；到上限仍没变，说明本来就没有待发的更新（实测 12–17 毫秒到），以请求前的
// 值为准，元素取最后一次读到的。中间读不到值时同样以请求前的值为准，首字之后的核对会把它
// 拦下来。没有定位元素时，更新请求也会让滞后的焦点报告换成真正的落点：读到的元素变了，即使
// 值恰好相同也以新元素为准，再等一轮。
static constexpr auto KCUALandingSettle = std::chrono::milliseconds(60);
static NSString *settledLandingValue(const KCUATargetRef &target,
                                     const KCUAOp &op) {
  id element = landingElement(target);
  NSString *stale = elementValue(element);
  if (!stale)
    return nil;
  refreshLanding(element, target->pid);
  auto started = std::chrono::steady_clock::now();
  auto deadline = started + KCUALandingSettle;
  for (;;) {
    KCUACheck(op);
    pauseLanding();
    id current = landingElement(target);
    NSString *value = elementValue(current);
    auto now = std::chrono::steady_clock::now();
    if (value && ![value isEqual:stale]) {
      landingBaseline = current;
      return value;
    }
    // 焦点报告来回变时不能一直等下去：总时长有上限。
    if (!sameLanding(current, element) &&
        now < started + 5 * KCUALandingSettle) {
      element = current;
      deadline = now + KCUALandingSettle;
    } else if (now >= deadline) {
      landingBaseline = current;
      return stale;
    }
    landingBaseline = current;
  }
}
// 文本已派发、落点元素的值却没变：如实报告没有落地，不报告成 accepted。
[[noreturn]] static void textNotInserted(bool foreground) {
  KCUAFail(
      foreground ? @"action_unavailable" : @"foreground_required",
      foreground
          ? @"Text was sent but the focused field did not change; inspect it "
            @"before retrying"
          : @"Text was sent to the background app but its focused field did "
            @"not change; bring the target window to the foreground and "
            @"retry, or set the value on the element",
      @{@"action_sent" : @YES,
        @"dispatch_status" : @"possibly_sent",
        @"reason_code" : @"text_insertion_not_observed"});
}
// 粘贴事务：保存剪贴板、写入待粘贴内容、发送 ⌘V，并在操作清理时恢复。
// board 由调用方给出（运行时是系统剪贴板），便于用独立剪贴板做回归。
void KCUAPasteText(NSPasteboard *board, const KCUATargetRef &target,
                   NSString *text, NSString *format, const KCUAOp &op) {
  forgetLanding();
  if (![text isKindOfClass:NSString.class] || text.length > 1024 * 1024 ||
      ![@[ @"text", @"md", @"html" ] containsObject:format])
    KCUAFail(@"invalid_request",
             @"Paste requires bounded text and format text, md or html");
  // 修复原因：接管剪贴板前要确认读取快照期间没有别人写入。否则用户此时复制的内容会被清空并覆盖，
  // 而事务清理时还能“成功”恢复成更早的快照，用户新复制的内容就此丢失。
  NSInteger observedChangeCount = board.changeCount;
  NSMutableArray *snapshot = [NSMutableArray array];
  NSUInteger bytes = 0;
  for (NSPasteboardItem *item in board.pasteboardItems) {
    NSMutableDictionary *record = [NSMutableDictionary dictionary];
    for (NSString *type in item.types) {
      NSData *data = [item dataForType:type];
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024)
        KCUAFail(@"action_unavailable",
                 @"Clipboard snapshot exceeds transaction limits");
      if (data)
        record[type] = data;
    }
    [snapshot addObject:record];
  }
  KCUAPasteProvider *provider = [KCUAPasteProvider new];
  NSData *utf8 = [KCUAScalarString(text, 1024 * 1024)
      dataUsingEncoding:NSUTF8StringEncoding];
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  if (![format isEqual:@"html"])
    payload[NSPasteboardTypeString] = utf8;
  if ([format isEqual:@"html"])
    payload[NSPasteboardTypeHTML] = utf8;
  if ([format isEqual:@"md"])
    payload[@"net.daringfireball.markdown"] = utf8;
  provider.payload = payload;
  NSPasteboardItem *item = [NSPasteboardItem new];
  [item setDataProvider:provider forTypes:payload.allKeys];
  if (board.changeCount != observedChangeCount)
    KCUAFail(@"action_unavailable",
             @"Clipboard changed while it was being saved; nothing was sent",
             @{@"action_sent" : @NO, @"dispatch_status" : @"not_sent"});
  // 通过复核后才接管：此前 savedClipboard 保持为空，清理时不会用旧快照覆盖用户刚复制的内容。
  ownedBoard = board;
  savedClipboard = snapshot;
  [board clearContents];
  [board writeObjects:@[ item ]];
  ownedClipboardCount = board.changeCount;
  KCUAPersistInputSafety();
  KCUACheck(op);
  KCUAValidateTarget(target);
  if (board.changeCount != ownedClipboardCount)
    KCUAFail(
        @"action_unavailable", @"Clipboard changed before paste dispatch",
        @{@"action_sent" : @NO});
  // 修复原因：回执原先只看"目标进程读取了剪贴板"。实测文本没有进入输入框时目标进程照样
  // 会读剪贴板：AppKit 应用不在前台时不处理 ⌘V 这类菜单快捷键，按键却已经送达窗口
  // （M2 的原生夹具与本机 keylab 一致，合成 target focus 也改变不了）。回执因此是
  // accepted，模型只能靠事后观察发现。现在能读到落点元素的值时以值为准；HTML 的源码与
  // 粘贴后的富文本内容不可比，仍只看剪贴板证据。
  NSString *before = [format isEqual:@"html"] ? nil : landingValue(target);
  bool foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier ==
                    target->pid;
  provider.dispatched = YES;
  KCUAKeyChord chord = KCUAParseKeyChord(@"cmd+v");
  keyDown(target, chord, op);
  releaseLastInput(true);
  auto settleDeadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
  std::chrono::steady_clock::time_point consumedAt;
  bool consumed = false;
  for (;;) {
    KCUACheck(op);
    KCUARequireDesktop();
    auto now = std::chrono::steady_clock::now();
    if (before) {
      NSString *after = landingValue(target);
      if (!after) {
        // 元素中途不可读：无法再判断是否落地，退回只看剪贴板证据。
        before = nil;
      } else if (![after isEqual:before] || [after containsString:text]) {
        break;
      }
    }
    if (!consumed && provider.provided) {
      consumed = true;
      consumedAt = now;
    }
    if (consumed) {
      if (!before)
        break;
      // 剪贴板已被读取而值没变：给目标一小段时间完成插入，仍没变就是没有落地。
      if (now >= consumedAt + std::chrono::milliseconds(300))
        textNotInserted(foreground);
    } else if (now >= settleDeadline) {
      if (before)
        textNotInserted(foreground);
      KCUAFail(
          @"action_unavailable",
          @"Target clipboard consumption was not observed; inspect before "
          @"retrying",
          @{@"action_sent" : @YES,
            @"dispatch_status" : @"possibly_sent"});
    }
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
  }
}
// 后台逐字符输入。修复原因（M2 2026-11-26、构建机 Chrome 158 / AppKit 实测）：⌘V 只有在目标
// 真正处于前台时才被当作菜单快捷键，投递给后台应用的粘贴键送达了窗口、输入框不变；同一通道里
// 不带修饰键、带字符的按键能进输入框。所以目标不在前台时 type 改发逐字符按键，paste 不改。
//
// 一个按键带一个 Unicode 标量。增补平面的字符（emoji 等）是两个 UTF-16 单元的代理对，必须整对
// 发出：Chromium 对恰好一个单元的按键走按键字符，对代理对走输入法提交，后台窗口里两条路都把
// 字符插进输入框（实测 Chrome 158）；把代理对拆成两段只会插进半个代理项。换行发 Return，
// 制表符发 Tab，与用户按键一致。
static const NSUInteger KCUABackgroundTypingLimit = 2048;
struct TypingStroke {
  CGKeyCode key;
  // 纯键位（Return、Tab）为空串。
  NSString *characters;
};
static std::vector<TypingStroke> typingStrokes(NSString *text) {
  std::vector<TypingStroke> strokes;
  NSUInteger length = text.length;
  for (NSUInteger at = 0; at < length;) {
    unichar unit = [text characterAtIndex:at];
    if (unit == '\r' || unit == '\n') {
      if (unit == '\r' && at + 1 < length &&
          [text characterAtIndex:at + 1] == '\n')
        at++;
      at++;
      strokes.push_back({KCUAParseKeyChord(@"return").key, @""});
    } else if (unit == '\t') {
      at++;
      strokes.push_back({KCUAParseKeyChord(@"tab").key, @""});
    } else {
      NSUInteger count =
          CFStringIsSurrogateHighCharacter(unit) && at + 1 < length &&
                  CFStringIsSurrogateLowCharacter(
                      [text characterAtIndex:at + 1])
              ? 2
              : 1;
      strokes.push_back({0, [text substringWithRange:NSMakeRange(at, count)]});
      at += count;
    }
  }
  return strokes;
}
// 一次按键：落下与抬起在同处校验、同处派发。与 press_key 走同一条 PID/窗口定向通道，
// 区别只是键上不带修饰键、带着要输入的字符。
static void postStroke(const KCUATargetRef &target, const TypingStroke &stroke,
                       const KCUAOp &op) {
  CGEventRef down = nullptr, up = nullptr;
  @try {
    KCUACheck(op);
    KCUAValidateTarget(target, true);
    KCUABeginScopedFocus(target, op);
    down = CGEventCreateKeyboardEvent(nullptr, stroke.key, true);
    up = CGEventCreateKeyboardEvent(nullptr, stroke.key, false);
    if (!down || !up)
      KCUAFail(@"action_unavailable",
               @"Could not construct target-scoped input event");
    std::vector<UniChar> units(stroke.characters.length);
    if (!units.empty())
      [stroke.characters
          getCharacters:units.data()
                 range:NSMakeRange(0, units.size())];
    for (CGEventRef event : { down, up }) {
      // 不继承用户此刻按着的修饰键：字符已经带在事件上，Shift 之类只会改变应用对它的解释。
      CGEventSetFlags(event, 0);
      if (!units.empty())
        CGEventKeyboardSetUnicodeString(event, units.size(), units.data());
      KCUAStampWindowEvent(event, target);
    }
    KCUACheck(op);
    KCUARequireDesktop();
    KCUARequireInputKeyWindow(target, false);
    op->dispatched = true;
    CGEventPostToPid(target->pid, down);
    CGEventPostToPid(target->pid, up);
  } @finally {
    if (down)
      CFRelease(down);
    if (up)
      CFRelease(up);
  }
}
static void typeBackgroundKeys(const KCUATargetRef &target, NSString *text,
                               const KCUAOp &op) {
  if (![text isKindOfClass:NSString.class])
    KCUAFail(@"invalid_request", @"Typing requires text", @{@"action_sent" : @NO});
  if (text.length > KCUABackgroundTypingLimit)
    KCUAFail(@"invalid_request",
             @"Background typing is limited to 2048 UTF-16 units; set the "
             "value on the element, or bring the target window to the "
             "foreground and paste",
             @{@"action_sent" : @NO, @"dispatch_status" : @"not_sent"});
  // 控制字符不是“输入的文字”：它们在应用里各有含义，派发前拒绝。
  for (NSUInteger index = 0; index < text.length; index++) {
    unichar unit = [text characterAtIndex:index];
    if ((unit < 0x20 && unit != '\t' && unit != '\r' && unit != '\n') ||
        unit == 0x7f || (unit >= 0x80 && unit <= 0x9f))
      KCUAFail(@"invalid_request",
               @"Background typing cannot send control characters other than "
               "tab and newlines",
               @{@"action_sent" : @NO, @"dispatch_status" : @"not_sent"});
  }
  text = KCUAScalarString(text, KCUABackgroundTypingLimit);
  auto strokes = typingStrokes(text);
  NSString *before = settledLandingValue(target, op);
  bool verify = before != nil;
  for (size_t index = 0; index < strokes.size(); index++) {
    postStroke(target, strokes[index], op);
    // 先发第一个带字符的按键并核对落点，值变了才发其余字符。不在非文本控件上连发按键：
    // 单个字母在不少应用里就是快捷键。Return / Tab 不带字符，直接发。
    if (!verify || !strokes[index].characters.length)
      continue;
    verify = false;
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(400);
    auto nextRefresh = std::chrono::steady_clock::time_point::min();
    for (;;) {
      KCUACheck(op);
      KCUARequireDesktop();
      id element = landingElement(target);
      if (std::chrono::steady_clock::now() >= nextRefresh) {
        refreshLanding(element, target->pid);
        nextRefresh = std::chrono::steady_clock::now() +
                      std::chrono::milliseconds(40);
        pauseLanding();
        element = landingElement(target);
      }
      // 修复原因：没有定位元素时，应用报告的焦点元素本身也可能还是上一次更新时的那个。基线
      // 取自别的控件，值不同不能算这个字符落了地（构建机 Chrome 158 实测：给只读框输入时基线
      // 取自上一个控件，回执成了 accepted）。焦点元素变了就以它重新取基线，下一个字符再核对。
      if (!sameLanding(element, landingBaseline)) {
        before = settledLandingValue(target, op);
        // 焦点元素已经不是值为字符串的控件：首字没有落在文本框里。
        if (!before)
          textNotInserted(false);
        verify = true;
        break;
      }
      // 首字之后读不到值（焦点离开文本控件）同样不算落地。
      NSString *after = elementValue(element);
      if (after && ![after isEqual:before])
        break;
      if (std::chrono::steady_clock::now() >= deadline)
        textNotInserted(false);
      pauseLanding();
    }
  }
}
static CGPoint pointParam(id value, CGRect allowed) {
  if (![value isKindOfClass:NSDictionary.class] ||
      ![value[@"x"] isKindOfClass:NSNumber.class] ||
      ![value[@"y"] isKindOfClass:NSNumber.class])
    KCUAFail(@"invalid_request", @"Point requires numeric x and y");
  CGPoint p = CGPointMake([value[@"x"] doubleValue], [value[@"y"] doubleValue]);
  if (!std::isfinite(p.x) || !std::isfinite(p.y) ||
      !CGRectContainsPoint(allowed, p))
    KCUAFail(
        @"element_unavailable",
        @"Coordinate lies outside the verified target window",
        @{@"action_sent" : @NO});
  return p;
}
// 输入前的定位点击：一次无修饰键的左键单击，与 click 方法的单次点击同一条路径。
static void clickOnce(const KCUATargetRef &target, CGPoint point,
                      const KCUAOp &op) {
  holds.push_back(
      {target, 0, 0, true, kCGMouseButtonLeft, CGPointZero, 1});
  KCUAPersistInputSafety();
  CGEventRef event =
      CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseDown, point,
                              kCGMouseButtonLeft);
  CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
  post(event, target, op);
  releaseLastInput(true);
}
void KCUAPositionTyping(NSDictionary *params, const KCUATargetRef &target,
                        const KCUAOp &op) {
  // 修复原因：带目标的 type 原先由 Host 拆成“定位”和“输入”两次原生请求。两次请求之间 worker
  // 可以处理别的请求，并发时交错成“聚焦 A → 聚焦 B → 输入 A 的文本”，两段文本都落进 B。
  // 定位与输入放进同一次原生操作后，中间不会再插入其他操作。
  id focus = params[@"focus_native"], click = params[@"click_native"],
    pointValue = params[@"click_point"];
  if ((focus ? 1 : 0) + (click ? 1 : 0) + (pointValue ? 1 : 0) > 1)
    KCUAFail(@"invalid_request",
             @"Pass only one of focus_native, click_native and click_point",
             @{@"action_sent" : @NO, @"dispatch_status" : @"not_sent"});
  if (focus || click) {
    // 复用 observation 的元素解析：令牌必须仍是本 peer、本会话观察到的元素。
    KCUATargetRef owner;
    AXUIElementRef element = KCUAResolveElement(
        @{@"native" : focus ? focus : click}, op, &owner);
    if (!element || !owner || owner->pid != target->pid ||
        owner->windowId != target->windowId ||
        ![owner->birth isEqual:target->birth])
      KCUAFail(@"element_unavailable", @"Typing target belongs to another window",
               @{@"action_sent" : @NO, @"dispatch_status" : @"not_sent"});
    KCUACheck(op);
    KCUARequireDesktop();
    // 修复原因：定位的元素就是这次输入的落点，落地核对读它，不再去找“应用当前的焦点元素”。
    // 修复前核对按应用报告的焦点元素取基线，而后台 Chromium 的焦点报告也是滞后的：给控件设
    // 焦点之后一段时间里仍返回上一个控件（构建机 Chrome 158 实测，几毫秒到上百毫秒不定）。
    if (focus) {
      op->dispatched = true;
      AXError error = AXUIElementSetAttributeValue(
          element, kAXFocusedAttribute, kCFBooleanTrue);
      if (error != kAXErrorSuccess)
        KCUAFail(@"action_unavailable",
                 @"Accessibility focus failed; inspect before retrying", @{
                   @"action_sent" : @YES,
                   @"dispatch_status" : @"possibly_sent",
                   @"ax_error" : @(error)
                 });
      rememberLanding((__bridge id)element, target);
      return;
    }
    // 显式事件路径：按元素当前的位置点击定位，不改动辅助功能焦点。
    CGRect bounds = KCUAAXBounds(element);
    if (CGRectIsEmpty(bounds))
      KCUAFail(@"element_unavailable", @"Typing target has no bounds",
               @{@"action_sent" : @NO});
    clickOnce(target, CGPointMake(CGRectGetMidX(bounds), CGRectGetMidY(bounds)),
              op);
    rememberLanding((__bridge id)element, target);
  }
  if (pointValue)
    clickOnce(target, pointParam(pointValue, target->bounds), op);
}
id KCUAInput(NSString *method, NSDictionary *params, const KCUAOp &op) {
  KCUACheck(op);
  if ([method isEqual:@"cancel_input_holds"]) {
    KCUAInputCleanup(op);
    return @{@"released" : @YES};
  }
  std::string policyKey =
      std::string(op->peer.UTF8String) + "\n" + op->session.UTF8String;
  if ([method isEqual:@"is_focus_steal_prevented"])
    return @(!activationPolicy.count(policyKey) || activationPolicy[policyKey]);
  if ([method isEqual:@"prevent_activation"] ||
      [method isEqual:@"reenable_activation"]) {
    activationPolicy[policyKey] = [method isEqual:@"prevent_activation"];
    return @YES;
  }
  KCUARequireAccessibility();
  recoverInputSafety();
  KCUATargetRef target;
  AXUIElementRef element = nullptr;
  if ([method hasPrefix:@"element_"])
    element = KCUAResolveElement(params, op, &target);
  else
    target = KCUAResolveTarget(params[@"app_ref"] ?: @{}, op, false);
  if (!element) {
    NSMutableDictionary *resolved = [params mutableCopy];
    auto pointForNative = [&](NSString *token) -> NSDictionary * {
      KCUATargetRef owner;
      AXUIElementRef observed =
          KCUAResolveElement(@{@"native" : token}, op, &owner);
      if (owner->pid != target->pid || owner->windowId != target->windowId ||
          ![owner->birth isEqual:target->birth])
        KCUAFail(
            @"element_unavailable", @"Event target belongs to another window",
            @{@"action_sent" : @NO});
      CGRect bounds = KCUAAXBounds(observed);
      if (CGRectIsEmpty(bounds) ||
          !CGRectIntersectsRect(bounds, target->bounds))
        KCUAFail(
            @"element_unavailable",
            @"Event target is not visible in the verified window",
            @{@"action_sent" : @NO});
      CGRect visible = CGRectIntersection(bounds, target->bounds);
      return
          @{@"x" : @(CGRectGetMidX(visible)),
            @"y" : @(CGRectGetMidY(visible))};
    };
    // 原生索引对应的事件点必须在派发前按 token 重取，不能直接使用旧树里的
    // bounds。
    if (params[@"native_target"])
      resolved[@"point"] = pointForNative(params[@"native_target"]);
    if (params[@"from_native"])
      resolved[@"from"] = pointForNative(params[@"from_native"]);
    if (params[@"to_native"])
      resolved[@"to"] = pointForNative(params[@"to_native"]);
    params = resolved;
  }
  if (activationPolicy.count(policyKey) && !activationPolicy[policyKey] &&
      NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !=
          target->pid)
    KCUAFail(
        @"foreground_required",
        @"The caller disabled background focus protection; foreground the "
        @"target manually",
        @{@"action_sent" : @NO});
  if (params[@"expected_desktop_epoch"] &&
      [params[@"expected_desktop_epoch"] unsignedLongLongValue] !=
          KCUADesktopEpoch())
    KCUAFail(
        @"stale_state", @"Coordinate desktop epoch changed",
        @{@"action_sent" : @NO});
  if (params[@"expected_cancellation_epoch"] &&
      [params[@"expected_cancellation_epoch"] unsignedLongLongValue] !=
          op->epoch)
    KCUAFail(
        @"stale_state", @"Coordinate cancellation epoch changed",
        @{@"action_sent" : @NO});
  if (params[@"expected_window_bounds"]) {
    NSDictionary *bounds = params[@"expected_window_bounds"];
    if (![bounds isKindOfClass:NSDictionary.class] ||
        !CGRectEqualToRect(CGRectMake([bounds[@"x"] doubleValue],
                                      [bounds[@"y"] doubleValue],
                                      [bounds[@"width"] doubleValue],
                                      [bounds[@"height"] doubleValue]),
                           target->bounds))
      KCUAFail(
          @"element_unavailable", @"Frame window geometry is stale",
          @{@"action_sent" : @NO});
  }
  if (params[@"expected_pid"] &&
      [params[@"expected_pid"] intValue] != target->pid)
    KCUAFail(
        @"element_unavailable", @"expected_pid differs from target app",
        @{@"action_sent" : @NO});
  if (params[@"expected_window_id"] &&
      [params[@"expected_window_id"] unsignedIntValue] != target->windowId)
    KCUAFail(
        @"element_unavailable",
        @"expected_window_id differs from target window",
        @{@"action_sent" : @NO});
  // 修复原因：截图记录的进程出生身份与显示拓扑原先没有参与核对。PID 被别的进程复用，或显示器
  // 拓扑变化而目标窗口矩形没变时，旧帧仍能通过上面 PID、窗口号与矩形的检查。
  if (params[@"expected_process_birth"] &&
      ![params[@"expected_process_birth"] isEqual:target->birth])
    KCUAFail(
        @"element_unavailable",
        @"expected_process_birth differs from target app",
        @{@"action_sent" : @NO});
  if (params[@"expected_display_topology"] &&
      ![params[@"expected_display_topology"]
          isEqual:KCUADisplayTopologyFingerprint()])
    KCUAFail(
        @"element_unavailable", @"Frame display topology is stale",
        @{@"action_sent" : @NO});
  if (element) {
    AXError error;
    if ([method isEqual:@"element_set_value"]) {
      if (![params[@"value"] isKindOfClass:NSString.class])
        KCUAFail(@"invalid_request", @"value must be text");
      Boolean settable = false;
      AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable);
      if (!settable)
        KCUAFail(
            @"not_settable", @"Observed element value is read only",
            @{@"action_sent" : @NO});
      KCUACheck(op);
      KCUARequireDesktop();
      op->dispatched = true;
      error = AXUIElementSetAttributeValue(
          element, kAXValueAttribute,
          (__bridge CFTypeRef)KCUAScalarString(params[@"value"], 1024 * 1024));
    } else if ([method isEqual:@"element_select_text"]) {
      CFRange nativeRange = KCUATextSelection(
          KCUAAXAttribute(element, kAXValueAttribute), params[@"text_range"]);
      AXValueRef selection = AXValueCreate(kAXValueTypeCFRange, &nativeRange);
      KCUACheck(op);
      KCUARequireDesktop();
      op->dispatched = true;
      error = AXUIElementSetAttributeValue(
          element, kAXSelectedTextRangeAttribute, selection);
      CFRelease(selection);
    } else if ([method isEqual:@"element_focus"]) {
      KCUACheck(op);
      KCUARequireDesktop();
      op->dispatched = true;
      error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute,
                                           kCFBooleanTrue);
    } else {
      NSString *action = [method isEqual:@"element_press"] ? @"AXPress"
                         : [method isEqual:@"element_show_menu"]
                             ? @"AXShowMenu"
                             : params[@"action"];
      if ([method isEqual:@"element_scroll"]) {
        NSString *direction = params[@"direction"];
        NSDictionary *actions = @{
          @"down" : @"AXScrollDownByPage",
          @"up" : @"AXScrollUpByPage",
          @"left" : @"AXScrollLeftByPage",
          @"right" : @"AXScrollRightByPage"
        };
        action = actions[direction];
      }
      CFArrayRef actionsRef = nullptr;
      AXUIElementCopyActionNames(element, &actionsRef);
      NSArray *actions = CFBridgingRelease(actionsRef);
      if (![action isKindOfClass:NSString.class] ||
          ![actions containsObject:action])
        KCUAFail(
            @"action_unavailable",
            @"Requested AX action is not supported by the observed element",
            @{@"action_sent" : @NO});
      KCUACheck(op);
      KCUARequireDesktop();
      op->dispatched = true;
      error = AXUIElementPerformAction(element, (__bridge CFStringRef)action);
    }
    if (error != kAXErrorSuccess)
      KCUAFail(
          @"action_unavailable",
          @"Accessibility action failed; inspect before retrying", @{
            @"action_sent" : @YES,
            @"dispatch_status" : @"possibly_sent",
            @"ax_error" : @(error)
          });
    return @{@"action_sent" : @YES, @"dispatch_status" : @"accepted"};
  }
  if ([method isEqual:@"paste"] || [method isEqual:@"type_text"] ||
      [method isEqual:@"type_text_to_app"]) {
    if ([method isEqual:@"type_text_to_app"])
      KCUAPositionTyping(params, target, op);
    NSString *text = params[@"text"], *format = params[@"format"] ?: @"text";
    // 派发前按目标是否在前台选定方式，派发后不改策略重试（见 typeBackgroundKeys）。
    // paste 与带格式的 type 必须是粘贴，后台仍如实返回 foreground_required。
    if (![method isEqual:@"paste"] && [format isEqual:@"text"] &&
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !=
            target->pid)
      typeBackgroundKeys(target, text, op);
    else
      KCUAPasteText(NSPasteboard.generalPasteboard, target, text, format, op);
  } else if ([method isEqual:@"press_key"] ||
           [method isEqual:@"press_key_to_app"] ||
           [method isEqual:@"hold_key"] ||
           [method isEqual:@"hold_key_to_app"]) {
    KCUAKeyChord chord = KCUAParseKeyChord(params[@"text"]);
    double seconds =
        [method hasPrefix:@"hold_key"] ? [params[@"duration"] doubleValue] : 0;
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 30)
      KCUAFail(@"invalid_request",
               @"Key hold duration must be between 0 and 30 seconds");
    keyDown(target, chord, op);
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds((int64_t)(seconds * 1000));
    while (std::chrono::steady_clock::now() < deadline) {
      KCUACheck(op);
      KCUAValidateTarget(target);
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    releaseLastInput(true);
  } else if ([method isEqual:@"scroll"]) {
    CGPoint point = pointParam(params[@"point"], target->bounds);
    NSString *direction = params[@"direction"] ?: @"down";
    if (![@[ @"down", @"up", @"left", @"right" ] containsObject:direction])
      KCUAFail(@"invalid_request", @"Invalid scroll direction");
    double pages = params[@"amount"] ? [params[@"amount"] doubleValue] : 1;
    if (!std::isfinite(pages) || pages <= 0 || pages > 100)
      KCUAFail(@"invalid_request",
               @"Scroll amount must be positive and at most 100 pages");
    bool vertical = [direction isEqual:@"down"] || [direction isEqual:@"up"];
    int pixels = (int)round(
        (vertical ? target->bounds.size.height : target->bounds.size.width) *
        0.8 * pages);
    int sign =
        [direction isEqual:@"down"] || [direction isEqual:@"right"] ? -1 : 1;
    for (int remaining = pixels; remaining > 0;) {
      int step = MIN(remaining, 48);
      remaining -= step;
      CGEventRef event = CGEventCreateScrollWheelEvent(
          nullptr, kCGScrollEventUnitPixel, 2, vertical ? step * sign : 0,
          vertical ? 0 : step * sign);
      CGEventSetLocation(event, point);
      CGEventSetIntegerValueField(event, kCGScrollWheelEventIsContinuous, 1);
      post(event, target, op);
      std::this_thread::sleep_for(std::chrono::milliseconds(3));
    }
  } else if ([method isEqual:@"click"] || [method isEqual:@"drag"]) {
    CGPoint from = pointParam([method isEqual:@"drag"] ? params[@"from"]
                                                       : params[@"point"],
                              target->bounds);
    CGPoint to = [method isEqual:@"drag"]
                     ? pointParam(params[@"to"], target->bounds)
                     : from;
    NSString *buttonName = params[@"button"] ?: @"left";
    if (![@[ @"left", @"right", @"middle" ] containsObject:buttonName])
      KCUAFail(@"invalid_request", @"Invalid mouse button");
    CGMouseButton button = [buttonName isEqual:@"right"] ? kCGMouseButtonRight
                           : [buttonName isEqual:@"middle"]
                               ? kCGMouseButtonCenter
                               : kCGMouseButtonLeft;
    CGEventType down = button == kCGMouseButtonLeft    ? kCGEventLeftMouseDown
                       : button == kCGMouseButtonRight ? kCGEventRightMouseDown
                                                       : kCGEventOtherMouseDown;
    CGEventFlags pointerFlags = 0;
    if (params[@"modifiers"]) {
      NSString *modifiers =
          [params[@"modifiers"] isKindOfClass:NSArray.class]
              ? [params[@"modifiers"] componentsJoinedByString:@"+"]
              : params[@"modifiers"];
      if (![modifiers isKindOfClass:NSString.class])
        KCUAFail(@"invalid_request",
                 @"Pointer modifiers must be a chord or modifier array");
      if (modifiers.length)
        pointerFlags =
            KCUAParseKeyChord([modifiers stringByAppendingString:@"+a"]).flags;
    }
    NSInteger clicks = params[@"clicks"] ? [params[@"clicks"] integerValue] : 1;
    if (clicks < 1 || clicks > 3)
      KCUAFail(@"invalid_request", @"Click count must be 1..3");
    for (NSInteger count = 1; count <= clicks; count++) {
      holds.push_back(
          {target, 0, pointerFlags, true, button, CGPointZero, count});
      KCUAPersistInputSafety();
      CGEventRef event = CGEventCreateMouseEvent(nullptr, down, from, button);
      CGEventSetFlags(event, pointerFlags);
      CGEventSetIntegerValueField(event, kCGMouseEventClickState, count);
      post(event, target, op);
      if ([method isEqual:@"drag"])
        for (int step = 1; step <= 40; step++) {
          CGPoint next = CGPointMake(from.x + (to.x - from.x) * step / 40,
                                     from.y + (to.y - from.y) * step / 40);
          CGEventRef dragged = CGEventCreateMouseEvent(
              nullptr,
              button == kCGMouseButtonLeft    ? kCGEventLeftMouseDragged
              : button == kCGMouseButtonRight ? kCGEventRightMouseDragged
                                              : kCGEventOtherMouseDragged,
              next, button);
          CGEventSetFlags(dragged, pointerFlags);
          post(dragged, target, op);
          std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
      releaseLastInput(true);
    }
  } else
    KCUAFail(@"method_not_found", @"Unknown native input method");
  return @{@"action_sent" : @YES, @"dispatch_status" : @"accepted"};
}
