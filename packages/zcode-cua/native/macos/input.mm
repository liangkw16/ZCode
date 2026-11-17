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

struct HeldInput {
  KCUATargetRef target;
  CGKeyCode key;
  CGEventFlags flags;
  bool mouse;
  CGMouseButton button;
  CGPoint point;
  bool dispatched = false;
};
static std::vector<HeldInput> holds;
static NSArray *savedClipboard;
static NSInteger ownedClipboardCount = -1;
static NSString *safetyPath;
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
void KCUAPersistInputSafety(void) {
  if (!safetyPath)
    return;
  NSDictionary *focus = KCUAScopedFocusRecoveryRecord();
  if (holds.empty() && !savedClipboard && !focus.count) {
    unlink(safetyPath.fileSystemRepresentation);
    return;
  }
  NSMutableArray *records = [NSMutableArray array];
  for (const auto &hold : holds)
    [records addObject:@{
      @"pid" : @(hold.target->pid),
      @"birth" : hold.target->birth,
      @"key" : @(hold.key),
      @"flags" : @(hold.flags),
      @"mouse" : @(hold.mouse),
      @"button" : @(hold.button),
      @"x" : @(hold.point.x),
      @"y" : @(hold.point.y)
    }];
  NSDictionary *journal = @{
    @"schema" : @1,
    @"helper_pid" : @(getpid()),
    @"helper_birth" : KCUAProcessBirth(getpid()),
    @"holds" : records,
    @"clipboard" : savedClipboard ?: @[],
    @"clipboard_count" : @(ownedClipboardCount),
    @"synthetic_focus" : focus,
    @"helper_generation" : KCUAGeneration() ?: @""
  };
  NSData *data = [NSPropertyListSerialization
      dataWithPropertyList:journal
                    format:NSPropertyListBinaryFormat_v1_0
                   options:0
                     error:nil];
  NSString *temporary =
      [safetyPath stringByAppendingFormat:@".%d.tmp", getpid()];
  int fd = open(temporary.fileSystemRepresentation,
                O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
  if (fd < 0)
    KCUAFail(@"cleanup_incomplete", @"Cannot create input-safety record");
  ssize_t bytes = write(fd, data.bytes, data.length);
  fsync(fd);
  close(fd);
  if (bytes != (ssize_t)data.length ||
      rename(temporary.fileSystemRepresentation,
             safetyPath.fileSystemRepresentation) != 0) {
    unlink(temporary.fileSystemRepresentation);
    KCUAFail(@"cleanup_incomplete", @"Cannot persist input-safety record");
  }
}
static void restoreClipboard(NSArray *saved, NSInteger ownerCount) {
  NSPasteboard *board = NSPasteboard.generalPasteboard;
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
void KCUAInputInitialize(NSString *runtimeDir) {
  safetyPath =
      [runtimeDir stringByAppendingPathComponent:@"input-safety.plist"];
  struct stat st;
  if (lstat(safetyPath.fileSystemRepresentation, &st) != 0)
    return;
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
      [record[@"schema"] intValue] != 1)
    KCUAFail(@"cleanup_incomplete", @"Input recovery record is malformed");
  pid_t previous = [record[@"helper_pid"] intValue];
  NSString *birth = KCUAProcessBirth(previous);
  if (birth && [birth isEqual:record[@"helper_birth"]])
    KCUAFail(@"controller_busy", @"Previous native input owner is still alive");
  for (NSDictionary *hold in record[@"holds"]) {
    pid_t pid = [hold[@"pid"] intValue];
    if (![hold[@"birth"] isEqual:KCUAProcessBirth(pid)])
      continue;
    CGEventRef event;
    if ([hold[@"mouse"] boolValue]) {
      CGMouseButton button = (CGMouseButton)[hold[@"button"] unsignedIntValue];
      event = CGEventCreateMouseEvent(
          nullptr,
          button == kCGMouseButtonLeft    ? kCGEventLeftMouseUp
          : button == kCGMouseButtonRight ? kCGEventRightMouseUp
                                          : kCGEventOtherMouseUp,
          CGPointMake([hold[@"x"] doubleValue], [hold[@"y"] doubleValue]),
          button);
    } else
      event = CGEventCreateKeyboardEvent(
          nullptr, (CGKeyCode)[hold[@"key"] unsignedIntValue], false);
    if (event) {
      CGEventSetFlags(event,
                      (CGEventFlags)[hold[@"flags"] unsignedLongLongValue]);
      CGEventPostToPid(pid, event);
      CFRelease(event);
    }
  }
  KCUARecoverScopedFocus(record[@"synthetic_focus"]);
  restoreClipboard(record[@"clipboard"],
                   [record[@"clipboard_count"] integerValue]);
  unlink(safetyPath.fileSystemRepresentation);
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
    CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer,
                                target->windowId);
    CGEventSetIntegerValueField(
        event, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,
        target->windowId);
    CGEventType kind = CGEventGetType(event);
    if (!holds.empty() &&
        (kind == kCGEventKeyDown || kind == kCGEventLeftMouseDown ||
         kind == kCGEventRightMouseDown || kind == kCGEventOtherMouseDown))
      holds.back().dispatched = true;
    if (CGEventGetType(event) != kCGEventKeyDown &&
        CGEventGetType(event) != kCGEventKeyUp &&
        CGEventGetType(event) != kCGEventFlagsChanged)
      KCUAGhostPoint(CGEventGetLocation(event));
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
static void keyUp(const KCUATargetRef &target, KCUAKeyChord chord) {
  if (![target->birth isEqual:KCUAProcessBirth(target->pid)])
    return;
  CGEventRef event = CGEventCreateKeyboardEvent(nullptr, chord.key, false);
  if (event) {
    CGEventSetFlags(event, 0);
    CGEventPostToPid(target->pid, event);
    CFRelease(event);
  }
  for (auto it = holds.begin(); it != holds.end(); ++it)
    if (!it->mouse && it->target == target && it->key == chord.key) {
      holds.erase(it);
      break;
    }
  KCUAPersistInputSafety();
}
void KCUAInputCleanup(const KCUAOp &op) {
  (void)op;
  for (auto it = holds.rbegin(); it != holds.rend(); ++it) {
    auto &hold = *it;
    if (!hold.dispatched)
      continue;
    if (![hold.target->birth isEqual:KCUAProcessBirth(hold.target->pid)])
      continue;
    CGEventRef event;
    if (hold.mouse)
      event = CGEventCreateMouseEvent(
          nullptr,
          hold.button == kCGMouseButtonLeft    ? kCGEventLeftMouseUp
          : hold.button == kCGMouseButtonRight ? kCGEventRightMouseUp
                                               : kCGEventOtherMouseUp,
          hold.point, hold.button);
    else
      event = CGEventCreateKeyboardEvent(nullptr, hold.key, false);
    if (event) {
      CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer,
                                  hold.target->windowId);
      CGEventSetIntegerValueField(
          event, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,
          hold.target->windowId);
      CGEventSetFlags(event, 0);
      CGEventPostToPid(hold.target->pid, event);
      CFRelease(event);
    }
  }
  holds.clear();
  @try {
    KCUAEndScopedFocus();
  } @finally {
    restoreClipboard(savedClipboard, ownedClipboardCount);
    savedClipboard = nil;
    ownedClipboardCount = -1;
    KCUAPersistInputSafety();
    if (op->cancelled)
      KCUAGhostHide();
  }
}
static void paste(const KCUATargetRef &target, NSString *text, NSString *format,
                  const KCUAOp &op) {
  if (![text isKindOfClass:NSString.class] || text.length > 1024 * 1024 ||
      ![@[ @"text", @"md", @"html" ] containsObject:format])
    KCUAFail(@"invalid_request",
             @"Paste requires bounded text and format text, md or html");
  NSPasteboard *board = NSPasteboard.generalPasteboard;
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
  savedClipboard = snapshot;
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
  provider.dispatched = YES;
  KCUAKeyChord chord = KCUAParseKeyChord(@"cmd+v");
  keyDown(target, chord, op);
  keyUp(target, chord);
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (!provider.provided) {
    KCUACheck(op);
    KCUARequireDesktop();
    if (std::chrono::steady_clock::now() >= deadline)
      KCUAFail(
          @"action_unavailable",
          @"Target clipboard consumption was not observed; inspect before "
          @"retrying",
          @{@"action_sent" : @YES,
            @"dispatch_status" : @"possibly_sent"});
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.005, true);
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
  KCUATargetRef target;
  AXUIElementRef element = nullptr;
  if ([method hasPrefix:@"element_"])
    element = KCUAResolveElement(params, op, &target);
  else
    target = KCUAResolveTarget(params[@"app_ref"] ?: @{}, op, false);
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
      [method isEqual:@"type_text_to_app"])
    paste(target, params[@"text"], params[@"format"] ?: @"text", op);
  else if ([method isEqual:@"press_key"] ||
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
    keyUp(target, chord);
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
    CGEventType up = button == kCGMouseButtonLeft    ? kCGEventLeftMouseUp
                     : button == kCGMouseButtonRight ? kCGEventRightMouseUp
                                                     : kCGEventOtherMouseUp;
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
      holds.push_back({target, 0, pointerFlags, true, button, from});
      KCUAPersistInputSafety();
      CGEventRef event = CGEventCreateMouseEvent(nullptr, down, from, button);
      CGEventSetFlags(event, pointerFlags);
      CGEventSetIntegerValueField(event, kCGMouseEventClickState, count);
      post(event, target, op);
      if ([method isEqual:@"drag"])
        for (int step = 1; step <= 40; step++) {
          CGPoint next = CGPointMake(from.x + (to.x - from.x) * step / 40,
                                     from.y + (to.y - from.y) * step / 40);
          holds.back().point = next;
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
      event = CGEventCreateMouseEvent(nullptr, up, to, button);
      CGEventSetFlags(event, pointerFlags);
      CGEventSetIntegerValueField(event, kCGMouseEventClickState, count);
      post(event, target, op);
      holds.pop_back();
      KCUAPersistInputSafety();
    }
  } else
    KCUAFail(@"method_not_found", @"Unknown native input method");
  return @{@"action_sent" : @YES, @"dispatch_status" : @"accepted"};
}
