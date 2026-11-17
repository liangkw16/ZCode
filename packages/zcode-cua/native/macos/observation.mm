#import "automation.h"
#include <chrono>
#include <cmath>
#include <dlfcn.h>
#include <map>
#include <vector>

id KCUAAXAttribute(AXUIElementRef element, CFStringRef attribute) {
  auto operation = KCUACurrentOperation();
  if (operation)
    KCUACheck(operation);
  CFTypeRef value = nullptr;
  if (!element || AXUIElementCopyAttributeValue(element, attribute, &value) !=
                      kAXErrorSuccess)
    return nil;
  return CFBridgingRelease(value);
}
CGRect KCUAAXBounds(AXUIElementRef element) {
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  id p = KCUAAXAttribute(element, kAXPositionAttribute),
     s = KCUAAXAttribute(element, kAXSizeAttribute);
  if (p && CFGetTypeID((__bridge CFTypeRef)p) == AXValueGetTypeID())
    AXValueGetValue((__bridge AXValueRef)p, kAXValueTypeCGPoint, &position);
  if (s && CFGetTypeID((__bridge CFTypeRef)s) == AXValueGetTypeID())
    AXValueGetValue((__bridge AXValueRef)s, kAXValueTypeCGSize, &size);
  return CGRectMake(position.x, position.y, size.width, size.height);
}
static NSDictionary *rectJSON(CGRect r) {
  return @{
    @"x" : @(r.origin.x),
    @"y" : @(r.origin.y),
    @"width" : @(r.size.width),
    @"height" : @(r.size.height)
  };
}
static NSArray *windowInfo(void) {
  return CFBridgingRelease(CGWindowListCopyWindowInfo(
      kCGWindowListExcludeDesktopElements, kCGNullWindowID));
}
static NSDictionary *infoForWindow(CGWindowID window, pid_t pid) {
  for (NSDictionary *entry in windowInfo())
    if ([entry[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] ==
            window &&
        [entry[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid)
      return entry;
  return nil;
}
static CGWindowID windowNumber(AXUIElementRef window, pid_t pid) {
  // 仅此处隔离系统未公开的 AX→WindowServer
  // 映射；不可用时只接受唯一的公开几何匹配。
  using GetWindow = AXError (*)(AXUIElementRef, CGWindowID *);
  static auto function =
      reinterpret_cast<GetWindow>(dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow"));
  CGWindowID number = 0;
  if (function && function(window, &number) == kAXErrorSuccess && number &&
      infoForWindow(number, pid))
    return number;
  CGRect bounds = KCUAAXBounds(window);
  CGWindowID candidate = 0;
  for (NSDictionary *entry in windowInfo()) {
    if ([entry[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid ||
        [entry[(__bridge NSString *)kCGWindowLayer] intValue] != 0)
      continue;
    CGRect rect = CGRectZero;
    CGRectMakeWithDictionaryRepresentation(
        (__bridge CFDictionaryRef)entry[(__bridge NSString *)kCGWindowBounds],
        &rect);
    if (fabs(rect.origin.x - bounds.origin.x) < 1 &&
        fabs(rect.origin.y - bounds.origin.y) < 1 &&
        fabs(rect.size.width - bounds.size.width) < 1 &&
        fabs(rect.size.height - bounds.size.height) < 1) {
      if (candidate)
        KCUAFail(@"element_unavailable", @"Window identity is ambiguous");
      candidate =
          [entry[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
    }
  }
  return candidate;
}
static NSDictionary *appJSON(NSRunningApplication *app) {
  return @{
    @"pid" : @(app.processIdentifier),
    @"bundle_id" : app.bundleIdentifier ?: [NSNull null],
    @"name" : KCUAScalarString(app.localizedName, 512) ?: @"",
    @"path" : app.bundleURL.path ?: [NSNull null]
  };
}
static NSRunningApplication *resolveRunning(NSDictionary *reference) {
  id pid = reference[@"pid"], bundle = reference[@"bundle_id"],
     name = reference[@"name"];
  if (pid) {
    if (![pid isKindOfClass:NSNumber.class] ||
        [pid doubleValue] != floor([pid doubleValue]) || [pid intValue] <= 1)
      KCUAFail(@"invalid_request",
               @"app_ref.pid must be a positive process ID");
    NSRunningApplication *app = [NSRunningApplication
        runningApplicationWithProcessIdentifier:[pid intValue]];
    if (bundle && ![bundle isEqual:app.bundleIdentifier])
      KCUAFail(@"element_unavailable",
               @"Application PID no longer matches its bundle identity");
    return app;
  }
  NSMutableArray<NSRunningApplication *> *matches = [NSMutableArray array];
  for (NSRunningApplication *app in NSWorkspace.sharedWorkspace
           .runningApplications) {
    if (bundle && [app.bundleIdentifier isEqual:bundle])
      [matches addObject:app];
    else if (!bundle && name &&
             ([app.localizedName isEqual:name] ||
              [app.bundleURL.lastPathComponent.stringByDeletingPathExtension
                  isEqual:name]))
      [matches addObject:app];
  }
  if (matches.count > 1)
    KCUAFail(@"element_unavailable",
             @"Application reference is ambiguous; use an observed PID");
  return matches.firstObject;
}
KCUATargetRef KCUAResolveTarget(NSDictionary *reference, const KCUAOp &op,
                                bool allowLaunch) {
  KCUACheck(op);
  KCUARequireAccessibility();
  if (![reference isKindOfClass:NSDictionary.class] || !reference.count)
    KCUAFail(@"invalid_request",
             @"An app_ref with pid, bundle_id or name is required");
  NSRunningApplication *app = resolveRunning(reference);
  if (!app && allowLaunch && !reference[@"pid"]) {
    NSURL *url;
    if ([reference[@"bundle_id"] isKindOfClass:NSString.class])
      url = [NSWorkspace.sharedWorkspace
          URLForApplicationWithBundleIdentifier:reference[@"bundle_id"]];
    if (!url && [reference[@"name"] isKindOfClass:NSString.class]) {
      NSString *name = reference[@"name"];
      if ([name rangeOfString:@"/"].location != NSNotFound ||
          [name rangeOfString:@".."].location != NSNotFound)
        KCUAFail(@"invalid_request", @"Application name must not be a path");
      for (NSString *root in @[
             @"/Applications", @"/System/Applications",
             [NSHomeDirectory()
                 stringByAppendingPathComponent:@"Applications"]
           ]) {
        NSString *path =
            [root stringByAppendingPathComponent:
                      [name hasSuffix:@".app"]
                          ? name
                          : [name stringByAppendingString:@".app"]];
        if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
          url = [NSURL fileURLWithPath:path];
          break;
        }
      }
    }
    if (url) {
      NSWorkspaceOpenConfiguration *configuration =
          [NSWorkspaceOpenConfiguration configuration];
      configuration.activates = NO;
      configuration.addsToRecentItems = NO;
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      __block NSRunningApplication *launched;
      [NSWorkspace.sharedWorkspace
          openApplicationAtURL:url
                 configuration:configuration
             completionHandler:^(NSRunningApplication *running,
                                 NSError *error) {
               (void)error;
               launched = running;
               dispatch_semaphore_signal(done);
             }];
      auto deadline =
          std::chrono::steady_clock::now() + std::chrono::seconds(8);
      while (dispatch_semaphore_wait(
                 done, dispatch_time(DISPATCH_TIME_NOW, 20000000)) != 0) {
        KCUACheck(op);
        if (std::chrono::steady_clock::now() >= deadline)
          KCUAFail(@"launch_failed",
                   @"Application background launch timed out");
      }
      app = launched;
    }
  }
  if (!app || app.terminated)
    KCUAFail(@"element_unavailable",
             @"Application is not running or could not be resolved");
  auto target = std::make_shared<KCUATarget>();
  target->pid = app.processIdentifier;
  target->desktopEpoch = KCUADesktopEpoch();
  target->birth = KCUAProcessBirth(target->pid);
  target->app = appJSON(app);
  if (!target->birth)
    KCUAFail(@"element_unavailable",
             @"Application process identity is unavailable");
  target->application = AXUIElementCreateApplication(target->pid);
  AXUIElementSetMessagingTimeout(target->application, 1.0);
  if ([app.bundleIdentifier hasPrefix:@"com.google.Chrome"] ||
      [app.bundleIdentifier hasPrefix:@"org.chromium."])
    AXUIElementSetAttributeValue(
        target->application, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
  NSArray *windows = KCUAAXAttribute(target->application, kAXWindowsAttribute);
  AXUIElementRef selected = nullptr;
  id focused;
  NSNumber *requested = reference[@"window_id"];
  if (requested && (![requested isKindOfClass:NSNumber.class] ||
                    requested.longLongValue <= 0))
    KCUAFail(@"invalid_request", @"window_id must be positive");
  if (requested) {
    for (id element in [windows isKindOfClass:NSArray.class] ? windows : @[])
      if (windowNumber((__bridge AXUIElementRef)element, target->pid) ==
          requested.unsignedIntValue) {
        selected = (__bridge AXUIElementRef)element;
        break;
      }
    if (!selected)
      KCUAFail(@"element_unavailable",
               @"Requested window closed or changed owner; list windows again");
  } else {
    focused = KCUAAXAttribute(target->application, kAXFocusedWindowAttribute);
    if (focused &&
        CFGetTypeID((__bridge CFTypeRef)focused) == AXUIElementGetTypeID())
      selected = (__bridge AXUIElementRef)focused;
    else if ([windows isKindOfClass:NSArray.class] && windows.count)
      selected = (__bridge AXUIElementRef)windows.firstObject;
  }
  if (!selected)
    KCUAFail(@"element_unavailable", @"Application has no readable AX window; "
                                     @"no focus or activation was attempted");
  target->window = (AXUIElementRef)CFRetain(selected);
  AXUIElementSetMessagingTimeout(target->window, 1.0);
  target->windowId = windowNumber(target->window, target->pid);
  target->bounds = KCUAAXBounds(target->window);
  if (!target->windowId)
    KCUAFail(@"element_unavailable",
             @"Cannot prove AX window ownership in WindowServer");
  return target;
}
void KCUAValidateTarget(const KCUATargetRef &target, bool requireSameGeometry) {
  KCUARequireAccessibility();
  if (target->desktopEpoch != KCUADesktopEpoch())
    KCUAFail(
        @"stale_state", @"Desktop availability changed; observe again",
        @{@"action_sent" : @NO});
  if (requireSameGeometry &&
      !CGRectEqualToRect(KCUAAXBounds(target->window), target->bounds))
    KCUAFail(
        @"element_unavailable",
        @"Target window moved or resized during input; observe again",
        @{@"action_sent" : @NO});
  if (![target->birth isEqual:KCUAProcessBirth(target->pid)] ||
      !infoForWindow(target->windowId, target->pid) ||
      !KCUAAXAttribute(target->window, kAXRoleAttribute))
    KCUAFail(
        @"element_unavailable",
        @"Observed application/window identity is stale",
        @{@"action_sent" : @NO});
}
struct ElementRecord {
  AXUIElementRef element;
  KCUATargetRef target;
  __strong NSString *peer, *session, *role, *title, *identifier;
  CGRect bounds;
  uint64_t epoch;
  ElementRecord(AXUIElementRef item)
      : element((AXUIElementRef)CFRetain(item)) {}
  ~ElementRecord() { CFRelease(element); }
};
static std::map<std::string, std::shared_ptr<ElementRecord>> elements;
static NSString *textAttribute(AXUIElementRef item, CFStringRef attribute,
                               NSUInteger limit = 4096) {
  id value = KCUAAXAttribute(item, attribute);
  return [value isKindOfClass:NSString.class] ? KCUAScalarString(value, limit)
                                              : nil;
}
static NSDictionary *describeElement(AXUIElementRef item,
                                     const KCUATargetRef &target,
                                     const KCUAOp &op, NSUInteger depth) {
  NSString *role = textAttribute(item, kAXRoleAttribute, 128);
  if (!role)
    return nil;
  NSString *title = textAttribute(item, kAXTitleAttribute)
                        ?: textAttribute(item, kAXDescriptionAttribute);
  NSString *value = textAttribute(item, kAXValueAttribute, 16384);
  NSString *identifier = textAttribute(item, kAXIdentifierAttribute, 1024);
  CFArrayRef actionsRef = nullptr;
  AXUIElementCopyActionNames(item, &actionsRef);
  NSArray *actions = CFBridgingRelease(actionsRef) ?: @[];
  CGRect bounds = KCUAAXBounds(item);
  auto record = std::make_shared<ElementRecord>(item);
  record->target = target;
  record->peer = op->peer;
  record->session = op->session;
  record->role = role;
  record->title = title;
  record->identifier = identifier;
  record->bounds = bounds;
  record->epoch = op->epoch;
  NSString *token = [NSUUID UUID].UUIDString;
  elements[token.UTF8String] = record;
  bool editable = [role isEqual:@"AXTextField"] ||
                  [role isEqual:@"AXTextArea"] || [role isEqual:@"AXComboBox"];
  return @{
    @"role" : role,
    @"kind" : editable       ? @"text_field"
    : [role hasPrefix:@"AX"] ? [role substringFromIndex:2].lowercaseString
                             : role.lowercaseString,
    @"title" : title ?: [NSNull null],
    @"value" : value ?: [NSNull null],
    @"bounds" : rectJSON(bounds),
    @"enabled" : KCUAAXAttribute(item, kAXEnabledAttribute) ?: @YES,
    @"editable" : @(editable),
    @"actions" : actions,
    @"focused" : KCUAAXAttribute(item, kAXFocusedAttribute) ?: @NO,
    @"selected" : KCUAAXAttribute(item, kAXSelectedAttribute) ?: @NO,
    @"pressable" : @([actions containsObject:@"AXPress"]),
    @"has_menu" : @([actions containsObject:@"AXShowMenu"]),
    @"native" : token,
    @"owner_pid" : @(target->pid),
    @"depth" : @(depth)
  };
}
static AXUIElementRef refetch(const std::shared_ptr<ElementRecord> &record,
                              const KCUAOp &op) {
  std::vector<id> stack;
  stack.push_back((__bridge id)record->target->window);
  AXUIElementRef candidate = nullptr;
  NSUInteger visited = 0;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (!stack.empty() && visited++ < 2048 &&
         std::chrono::steady_clock::now() < deadline) {
    KCUACheck(op);
    id item = stack.back();
    stack.pop_back();
    AXUIElementRef node = (__bridge AXUIElementRef)item;
    bool sameRole =
        [textAttribute(node, kAXRoleAttribute, 128) isEqual:record->role];
    bool sameIdentity =
        record->identifier.length
            ? [textAttribute(node, kAXIdentifierAttribute, 1024)
                  isEqual:record->identifier]
            : (record->title.length &&
               [textAttribute(node, kAXTitleAttribute)
                       ?: textAttribute(node, kAXDescriptionAttribute)
                   isEqual:record->title] &&
               CGRectEqualToRect(KCUAAXBounds(node), record->bounds));
    if (sameRole && sameIdentity) {
      if (candidate) {
        CFRelease(candidate);
        KCUAFail(
            @"element_unavailable",
            @"Element refetch matched multiple controls",
            @{@"action_sent" : @NO});
      }
      candidate = (AXUIElementRef)CFRetain(node);
    }
    NSArray *children = KCUAAXAttribute(node, kAXChildrenAttribute);
    for (id child in [children isKindOfClass:NSArray.class] ? children : @[])
      stack.push_back(child);
  }
  return candidate;
}
AXUIElementRef KCUAResolveElement(NSDictionary *params, const KCUAOp &op,
                                  KCUATargetRef *target) {
  NSString *token = params[@"native"];
  if (![token isKindOfClass:NSString.class])
    KCUAFail(@"invalid_request", @"A native element token is required");
  auto found = elements.find(token.UTF8String);
  if (found == elements.end() || ![found->second->peer isEqual:op->peer] ||
      ![found->second->session isEqual:op->session])
    KCUAFail(
        @"element_unavailable",
        @"Native element belongs to another or retired observation",
        @{@"action_sent" : @NO});
  auto record = found->second;
  if (record->epoch != op->epoch)
    KCUAFail(
        @"element_unavailable", @"Native element cancellation epoch changed",
        @{@"action_sent" : @NO});
  KCUACheck(op);
  KCUAValidateTarget(record->target);
  bool identityMatches =
      [textAttribute(record->element, kAXRoleAttribute, 128)
          isEqual:record->role] &&
      (record->identifier.length
           ? [textAttribute(record->element, kAXIdentifierAttribute, 1024)
                 isEqual:record->identifier]
           : ((record->title.length == 0 ||
               [(textAttribute(record->element, kAXTitleAttribute)
                     ?: textAttribute(record->element, kAXDescriptionAttribute))
                   isEqual:record->title]) &&
              CGRectEqualToRect(KCUAAXBounds(record->element),
                                record->bounds)));
  if (!identityMatches) {
    AXUIElementRef replacement = refetch(record, op);
    if (!replacement)
      KCUAFail(
          @"element_unavailable",
          @"Observed element changed and cannot be uniquely refetched",
          @{@"action_sent" : @NO});
    CFRelease(record->element);
    record->element = replacement;
  }
  *target = record->target;
  return record->element;
}
id KCUAObservation(NSString *method, NSDictionary *params, const KCUAOp &op) {
  KCUACheck(op);
  KCUARequireDesktop();
  if ([method isEqual:@"list_applications"]) {
    NSMutableArray *apps = [NSMutableArray array];
    for (NSRunningApplication *app in NSWorkspace.sharedWorkspace
             .runningApplications)
      if (app.activationPolicy == NSApplicationActivationPolicyRegular &&
          !app.terminated && app.processIdentifier != getpid())
        [apps addObject:appJSON(app)];
    return apps;
  }
  if ([method isEqual:@"application_info"]) {
    NSRunningApplication *app = resolveRunning(params[@"app_ref"] ?: @{});
    return app ? appJSON(app) : [NSNull null];
  }
  if ([method isEqual:@"read_element"]) {
    KCUATargetRef owner;
    AXUIElementRef item = KCUAResolveElement(params, op, &owner);
    return describeElement(item, owner, op, 0);
  }
  if ([method isEqual:@"element_at_point"]) {
    if (![params[@"x"] isKindOfClass:NSNumber.class] ||
        ![params[@"y"] isKindOfClass:NSNumber.class] ||
        !std::isfinite([params[@"x"] doubleValue]) ||
        !std::isfinite([params[@"y"] doubleValue]))
      KCUAFail(@"invalid_request", @"element_at_point requires finite x and y");
    KCUARequireAccessibility();
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementRef hit = nullptr;
    AXError error = AXUIElementCopyElementAtPosition(
        system, [params[@"x"] floatValue], [params[@"y"] floatValue], &hit);
    CFRelease(system);
    if (error != kAXErrorSuccess || !hit)
      return [NSNull null];
    @try {
      pid_t pid = 0;
      AXUIElementGetPid(hit, &pid);
      id window = KCUAAXAttribute(hit, kAXWindowAttribute);
      if (!window)
        KCUAFail(@"element_unavailable",
                 @"Hit element has no verifiable window");
      CGWindowID number = windowNumber((__bridge AXUIElementRef)window, pid);
      auto owner = KCUAResolveTarget(
          @{@"pid" : @(pid),
            @"window_id" : @(number)},
          op, false);
      return describeElement(hit, owner, op, 0);
    } @finally {
      CFRelease(hit);
    }
  }
  if ([method isEqual:@"list_windows"]) {
    KCUARequireAccessibility();
    NSRunningApplication *app = resolveRunning(params[@"app_ref"] ?: @{});
    if (!app)
      KCUAFail(@"element_unavailable", @"Application reference is not running");
    auto target = std::make_shared<KCUATarget>();
    target->pid = app.processIdentifier;
    target->application = AXUIElementCreateApplication(target->pid);
    AXUIElementSetMessagingTimeout(target->application, 1.0);
    NSMutableArray *result = [NSMutableArray array];
    NSArray *windows =
        KCUAAXAttribute(target->application, kAXWindowsAttribute);
    for (id item in [windows isKindOfClass:NSArray.class] ? windows : @[]) {
      AXUIElementRef window = (__bridge AXUIElementRef)item;
      CGWindowID number = windowNumber(window, target->pid);
      if (!number)
        continue;
      NSDictionary *info = infoForWindow(number, target->pid);
      [result addObject:@{
        @"window_id" : @(number),
        @"title" : textAttribute(window, kAXTitleAttribute) ?: @"",
        @"bounds" : rectJSON(KCUAAXBounds(window)),
        @"onscreen" : info[(__bridge NSString *)kCGWindowIsOnscreen] ?: @NO,
        @"focused" : @([KCUAAXAttribute(window, kAXFocusedAttribute) boolValue])
      }];
    }
    return result;
  }
  auto target = KCUAResolveTarget(params[@"app_ref"] ?: @{}, op,
                                  [method isEqual:@"capture_app"]);
  if ([method isEqual:@"application_info"])
    return target->app;
  if ([method isEqual:@"read_element"]) {
    KCUATargetRef owner;
    AXUIElementRef item = KCUAResolveElement(params, op, &owner);
    return describeElement(item, owner, op, 0);
  }
  if (![method isEqual:@"capture_app"])
    KCUAFail(@"method_not_found", @"Unknown observation method");
  for (auto it = elements.begin(); it != elements.end();) {
    auto &r = it->second;
    if ([r->peer isEqual:op->peer] && [r->session isEqual:op->session] &&
        r->target->pid == target->pid &&
        r->target->windowId == target->windowId)
      it = elements.erase(it);
    else
      ++it;
  }
  if (elements.size() > 16384)
    KCUAFail(@"broker_unavailable",
             @"Native observation registry capacity reached");
  NSMutableArray *flat = [NSMutableArray array];
  struct Pending {
    __strong id item;
    NSUInteger depth;
  };
  std::vector<Pending> pending;
  pending.push_back({(__bridge id)target->window, 0});
  size_t payloadBytes = 0;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!pending.empty() && flat.count < 2048 &&
         std::chrono::steady_clock::now() < deadline) {
    KCUACheck(op);
    auto node = pending.back();
    pending.pop_back();
    AXUIElementRef item = (__bridge AXUIElementRef)node.item;
    NSDictionary *description = describeElement(item, target, op, node.depth);
    if (description) {
      payloadBytes += [NSJSONSerialization dataWithJSONObject:description
                                                      options:0
                                                        error:nil]
                          .length;
      if (payloadBytes > 1024 * 1024)
        break;
      [flat addObject:description];
    }
    if (node.depth >= 40)
      continue;
    NSArray *children = KCUAAXAttribute(item, kAXChildrenAttribute);
    if (![children isKindOfClass:NSArray.class])
      continue;
    for (NSInteger index = (NSInteger)children.count - 1;
         index >= 0 && pending.size() < 4096; index--)
      pending.push_back({children[(NSUInteger)index], node.depth + 1});
  }
  KCUAValidateTarget(target);
  NSMutableDictionary *snapshot = [@{
    @"app" : target->app,
    @"window" : @{
      @"window_id" : @(target->windowId),
      @"actual_window_id" : @(target->windowId),
      @"presentation_window_id" : @(target->windowId),
      @"actual_owner_pid" : @(target->pid),
      @"title" : textAttribute(target->window, kAXTitleAttribute) ?: @"",
      @"bounds" : rectJSON(target->bounds)
    },
    @"elements" : flat,
    @"state_id" : [NSUUID UUID].UUIDString,
    @"snapshot_mode" : @"full",
    @"truncated" : @(!pending.empty()),
    @"screenshot" : [NSNull null],
    @"screenshot_blank" : @NO
  } mutableCopy];
  if (params[@"include_screenshot"] == nil ||
      [params[@"include_screenshot"] boolValue]) {
    @try {
      NSDictionary *capture = KCUACapture(target, op);
      [snapshot addEntriesFromDictionary:capture];
    } @catch (NSException *error) {
      if ([error.name isEqual:@"cancelled"] ||
          [error.name isEqual:@"cleanup_incomplete"])
        @throw;
      snapshot[@"screenshot_error"] =
          @{@"code" : error.name, @"message" : error.reason};
    }
  }
  snapshot[@"cancellation_epoch"] = @(op->epoch);
  snapshot[@"desktop_epoch"] = @(KCUADesktopEpoch());
  KCUACheck(op);
  KCUARequireDesktop();
  KCUAPresentationCapture(target, params[@"pip_session_context"]);
  return snapshot;
}
