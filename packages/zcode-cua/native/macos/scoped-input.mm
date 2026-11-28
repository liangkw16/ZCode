#import "automation.h"
#include <array>
#include <cstring>
#include <dlfcn.h>
// ABI facts: see ../THIRD_PARTY_NOTICES.md. No global event posting or
// activation API is used.
namespace {
struct ProcessNumber {
  uint32_t high;
  uint32_t low;
};
using ProcessForPID = int32_t (*)(pid_t, ProcessNumber *);
using EventRecord = int32_t (*)(const ProcessNumber *, const uint8_t *);
using WindowLocation = void (*)(CGEventRef, double, double);
using IntegerField = void (*)(CGEventRef, uint32_t, int64_t);
struct API {
  void *sky =
      dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
             RTLD_LAZY | RTLD_LOCAL);
  void *application =
      dlopen("/System/Library/Frameworks/ApplicationServices.framework/"
             "ApplicationServices",
             RTLD_LAZY | RTLD_LOCAL);
  ProcessForPID process = reinterpret_cast<ProcessForPID>(
      dlsym(application ?: RTLD_DEFAULT, "GetProcessForPID"));
  EventRecord record = reinterpret_cast<EventRecord>(
      dlsym(sky ?: RTLD_DEFAULT, "SLPSPostEventRecordTo"));
  WindowLocation location = reinterpret_cast<WindowLocation>(
      dlsym(sky ?: RTLD_DEFAULT, "CGEventSetWindowLocation"));
  IntegerField integer = reinterpret_cast<IntegerField>(
      dlsym(sky ?: RTLD_DEFAULT, "SLEventSetIntegerValueField"));
  bool available() const { return process && record && location && integer; }
};
API &api() {
  static API instance;
  return instance;
}
KCUATargetRef focusTarget;
bool focusWasForeground = false;
void focusRecord(const KCUATargetRef &target, bool focused) {
  ProcessNumber process = {};
  if (!api().available() || api().process(target->pid, &process) != 0)
    KCUAFail(
        @"foreground_required", @"Target-scoped focus ABI is unavailable",
        @{@"action_sent" : @NO});
  std::array<uint8_t, 0xF8> record = {};
  record[4] = 0xF8;
  record[8] = 0x0D;
  uint32_t window = CFSwapInt32HostToLittle(target->windowId);
  memcpy(record.data() + 0x3C, &window, sizeof(window));
  record[0x8A] = focused ? 1 : 2;
  if (api().record(&process, record.data()) != 0)
    KCUAFail(@"action_unavailable",
             @"Synthetic target-focus notification failed");
}
} // namespace
bool KCUAScopedInputAvailable(void) { return api().available(); }
void KCUABeginScopedFocus(const KCUATargetRef &target, const KCUAOp &op) {
  KCUACheck(op);
  KCUAValidateTarget(target);
  if (focusTarget)
    return;
  if (!api().available())
    KCUAFail(
        @"foreground_required",
        @"Background input capability is unavailable; no global fallback is "
        @"permitted",
        @{@"action_sent" : @NO});
  focusWasForeground =
      NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier ==
      target->pid;
  if (focusWasForeground)
    return;
  focusTarget = target;
  KCUAPersistInputSafety();
  focusRecord(target, true);
}
void KCUAEndScopedFocus(void) {
  if (!focusTarget)
    return;
  auto target = focusTarget;
  // 用户在动作期间主动切到目标应用时，不发送失活通知覆盖用户的新选择。
  if (!focusWasForeground &&
      NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !=
          target->pid) {
    auto verified = KCUAResolveInputReleaseTarget(target->pid, target->birth,
                                                  target->windowId);
    if (verified)
      focusRecord(verified, false);
  }
  focusTarget.reset();
  KCUAPersistInputSafety();
}
void KCUAStampWindowEvent(CGEventRef event, const KCUATargetRef &target) {
  if (!api().available())
    KCUAFail(@"action_unavailable", @"Window-scoped event ABI is unavailable");
  // 字段 51 为目标窗口号；公开的 91/92 只表示 pointer
  // hit-test，并不能取代窗口定向。
  api().integer(event, 51, target->windowId);
  CGEventSetIntegerValueField(event, kCGEventTargetUnixProcessID, target->pid);
  CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer,
                              target->windowId);
  CGEventSetIntegerValueField(
      event, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,
      target->windowId);
  CGEventType type = CGEventGetType(event);
  if (type != kCGEventKeyDown && type != kCGEventKeyUp &&
      type != kCGEventFlagsChanged) {
    CGPoint global = CGEventGetLocation(event);
    api().location(event, global.x - target->bounds.origin.x,
                   global.y - target->bounds.origin.y);
  }
}

NSDictionary *KCUAScopedFocusRecoveryRecord(void) {
  if (!focusTarget)
    return @{};
  return @{
    @"pid" : @(focusTarget->pid),
    @"birth" : focusTarget->birth,
    @"window_id" : @(focusTarget->windowId)
  };
}
void KCUARecoverScopedFocus(NSDictionary *record) {
  if (![record isKindOfClass:NSDictionary.class] || !record.count)
    return;
  pid_t pid = [record[@"pid"] intValue];
  if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid)
    return;
  auto target = KCUAResolveInputReleaseTarget(
      pid, record[@"birth"], [record[@"window_id"] unsignedIntValue]);
  if (target)
    focusRecord(target, false);
}
