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
id KCUAObservation(NSString *method, NSDictionary *params, const KCUAOp &op);
AXUIElementRef KCUAResolveElement(NSDictionary *params, const KCUAOp &op,
                                  KCUATargetRef *target);
NSDictionary *KCUACapture(const KCUATargetRef &target, const KCUAOp &op);
id KCUAInput(NSString *method, NSDictionary *params, const KCUAOp &op);
void KCUAInputCleanup(const KCUAOp &op);
id KCUAPresentation(NSString *method, NSDictionary *params, const KCUAOp &op);

bool KCUAScopedInputAvailable(void);
void KCUABeginScopedFocus(const KCUATargetRef &target, const KCUAOp &op);
void KCUAEndScopedFocus(void);
void KCUAStampWindowEvent(CGEventRef event, const KCUATargetRef &target);

void KCUAPresentationInitialize(bool enabled);
void KCUAPresentationCapture(const KCUATargetRef &target,
                             NSDictionary *context);
void KCUAGhostPoint(CGPoint point);
void KCUAGhostHide(void);

NSDictionary *KCUAScopedFocusRecoveryRecord(void);
void KCUARecoverScopedFocus(NSDictionary *record);
void KCUAPersistInputSafety(void);

void KCUASuspendPresentationForDesktop(void);
