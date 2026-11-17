#pragma once
#import <Cocoa/Cocoa.h>
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>

struct KCUAOperation {
  std::string key;
  __strong NSString *peer;
  __strong NSString *session;
  __strong NSString *operationId;
  __strong NSString *method;
  __strong NSDictionary *params;
  __strong NSDictionary *response;
  std::atomic<bool> cancelled{false};
  std::atomic<bool> dispatched{false};
  std::atomic<bool> settled{false};
  std::atomic<bool> admitted{false};
  std::atomic<bool> cleanupComplete{false};
  uint64_t epoch = 0;
  std::mutex mutex;
  std::condition_variable changed;
};
using KCUAOp = std::shared_ptr<KCUAOperation>;
NSDictionary *KCUAOK(id result);
NSDictionary *KCUAError(NSString *code, NSString *message,
                        NSDictionary *details = nil);
[[noreturn]] void KCUAFail(NSString *code, NSString *message,
                           NSDictionary *details = nil);
NSString *KCUAProcessBirth(pid_t pid);
NSString *KCUAExecutable(pid_t pid);
bool KCUAIsReadOnly(NSString *method);
bool KCUAMainLoopResponsive(double seconds);
void KCUACoordinatorStart(NSString *runtimeDir, NSString *socketPath);
void KCUACoordinatorStop(void);
NSDictionary *KCUASubmit(NSString *method, NSDictionary *params, NSString *peer,
                         NSDictionary *context,
                         std::atomic<bool> *connectionClosed);
NSDictionary *KCUAControl(NSString *method, NSDictionary *params,
                          NSString *peer, NSDictionary *context);
void KCUACancelPeer(NSString *peer);
void KCUACheck(const KCUAOp &op);
id KCUADispatch(NSString *method, NSDictionary *params, const KCUAOp &op);
void KCUACleanup(const KCUAOp &op);
NSDictionary *KCUALeaseStatus(void);
void KCUAAcquireLease(void);
void KCUAReleaseLease(void);
void KCUAStartServer(NSString *socketPath, NSString *runtimeDir,
                     bool allowDevelopment);
void KCUAStopServer(void);
NSString *KCUAGeneration(void);

NSString *KCUADesktopAvailability(void);
void KCUARequireDesktop(void);
void KCUARequireAccessibility(void);
NSDictionary *KCUAPermissionStatus(void);
NSString *KCUAScalarString(NSString *input, NSUInteger limit);

void KCUAInputInitialize(NSString *runtimeDir);
KCUAOp KCUACurrentOperation(void);

void KCUAPresentationInitialize(bool enabled);

void KCUANotifyDesktopUnavailable(void);
uint64_t KCUADesktopEpoch(void);
uint64_t KCUASessionEpoch(NSString *peer, NSString *session);
void KCUAStartAvailabilityTracking(void);
void KCUAStopAvailabilityTracking(void);

void KCUASuspendPresentationForDesktop(void);
