#pragma once
#import "protocol.h"
#import <ApplicationServices/ApplicationServices.h>
struct KCUATarget {
  pid_t pid = 0;
  CGWindowID windowId = 0;
  uint64_t desktopEpoch = 0;
  CGRect bounds = CGRectZero;
  __strong NSString *birth;
  __strong NSDictionary *app;
  AXUIElementRef application = nullptr;
  AXUIElementRef window = nullptr;
  ~KCUATarget() {
    if (application)
      CFRelease(application);
    if (window)
      CFRelease(window);
  }
};
using KCUATargetRef = std::shared_ptr<KCUATarget>;
id KCUAAXAttribute(AXUIElementRef element, CFStringRef attribute);
CGRect KCUAAXBounds(AXUIElementRef element);
KCUATargetRef KCUAResolveTarget(NSDictionary *reference, const KCUAOp &op,
                                bool allowLaunch);
void KCUAValidateTarget(const KCUATargetRef &target,
                        bool requireSameGeometry = false);
KCUATargetRef KCUAResolveInputReleaseTarget(pid_t pid, NSString *birth,
                                            CGWindowID window);
void KCUARequireInputKeyWindow(const KCUATargetRef &target, bool releasing);
id KCUAObservation(NSString *method, NSDictionary *params, const KCUAOp &op);
AXUIElementRef KCUAResolveElement(NSDictionary *params, const KCUAOp &op,
                                  KCUATargetRef *target);
NSDictionary *KCUACapture(const KCUATargetRef &target, const KCUAOp &op);
id KCUAInput(NSString *method, NSDictionary *params, const KCUAOp &op);
// 输入前的目标定位，三选一：focus_native（AX 聚焦该元素）、click_native（点击该元素当前的中心）、
// click_point（点击已验证窗口内的一点）。与随后的输入在同一次原生操作里完成。
void KCUAPositionTyping(NSDictionary *params, const KCUATargetRef &target,
                        const KCUAOp &op);
// 粘贴事务；运行时传入系统剪贴板，测试可传入独立剪贴板。
void KCUAPasteText(NSPasteboard *board, const KCUATargetRef &target,
                   NSString *text, NSString *format, const KCUAOp &op);
void KCUAInputCleanup(const KCUAOp &op);
id KCUAPresentation(NSString *method, NSDictionary *params, const KCUAOp &op);

bool KCUAScopedInputAvailable(void);
void KCUABeginScopedFocus(const KCUATargetRef &target, const KCUAOp &op);
void KCUAEndScopedFocus(void);
void KCUAStampWindowEvent(CGEventRef event, const KCUATargetRef &target);

// KCUAPresentationInitialize 的声明在 protocol.h（PiP 与 ghost cursor 两个开关）。
void KCUAPresentationCapture(const KCUATargetRef &target,
                             NSDictionary *context);
void KCUAGhostPoint(CGPoint point);
void KCUAGhostHide(void);

NSDictionary *KCUAScopedFocusRecoveryRecord(void);
void KCUARecoverScopedFocus(NSDictionary *record);
void KCUAPersistInputSafety(void);

void KCUASuspendPresentationForDesktop(void);
