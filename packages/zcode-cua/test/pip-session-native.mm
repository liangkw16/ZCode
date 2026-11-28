#import "../native/macos/automation.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <cassert>
#include <objc/runtime.h>

// PiP 目标的登记不以控制 lease 为前提：只做观察的回合也出现面板。
//
// 修复前的现场（M2，2026-11-26）：KCUAPresentationCapture 先查 is_owner。只读观察从不获取控制
// lease，两个只做观察的回合因此没有面板；同一会话只要做过一次写操作，之后的观察才有。
// 这里把 ScreenCaptureKit 的内容查询换成计数器：startLive 每取流一次计一次，不建窗口、不截屏。
static NSInteger shareRequests;
static BOOL leaseOwner;

NSString *KCUADesktopAvailability(void) { return @"unlocked"; }
NSDictionary *KCUALeaseStatus(void) {
  return @{ @"is_owner" : @(leaseOwner), @"controlled" : @(leaseOwner) };
}
void KCUARequireDesktop(void) {}
KCUATargetRef KCUAResolveTarget(NSDictionary *, const KCUAOp &, bool) {
  assert(false);
  return nullptr;
}
static void installShareCounter(void) {
  Method method = class_getClassMethod(
      SCShareableContent.class,
      @selector(getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:
                                                          completionHandler:));
  assert(method);
  method_setImplementation(method, imp_implementationWithBlock(^(
                                   id, BOOL, BOOL,
                                   void (^completion)(SCShareableContent *,
                                                      NSError *)) {
    shareRequests += 1;
    // 不给任何窗口：取流到此为止，测试进程不需要 WindowServer。
    completion(nil, [NSError errorWithDomain:@"pip-session-fixture" code:1
                                      userInfo:nil]);
  }));
}

int main(void) {
  @autoreleasepool {
    installShareCounter();
    KCUAPresentationInitialize(true, false);
    auto op = std::make_shared<KCUAOperation>();
    op->peer = @"fixture-peer";
    op->session = @"fixture-session";
    NSString *session = @"fixture-session";
    auto event = ^(NSDictionary *body) { return @{@"event" : body}; };
    auto target = std::make_shared<KCUATarget>();
    target->pid = 101;
    target->windowId = 17;
    target->birth = @"fixture-birth";
    auto observe = ^(NSString *turn) {
      KCUAPresentationCapture(target, @{ @"session_id" : session, @"turn_id" : turn });
    };

    // 回合与活动会话先于任何观察到达；此时还没有目标，不取流。
    KCUAPresentation(@"pip_session_event",
                     event(@{ @"kind" : @"turn-started", @"sessionId" : session,
                              @"turnId" : @"turn-1", @"eventId" : @"e1",
                              @"sequenceNumber" : @1 }),
                     op);
    KCUAPresentation(@"pip_session_event",
                     event(@{ @"kind" : @"focus-changed", @"sessionId" : session,
                              @"revision" : @1 }),
                     op);
    assert(shareRequests == 0);

    // Helper 不持有控制 lease 的只读回合：观察到目标窗口就开始取流。
    leaseOwner = NO;
    observe(@"turn-1");
    assert(shareRequests == 1);

    // 回合结束后目标作废；同一会话的新回合要先有新的观察。
    KCUAPresentation(@"pip_session_event",
                     event(@{ @"kind" : @"turn-ended", @"sessionId" : session,
                              @"turnId" : @"turn-1", @"eventId" : @"e2",
                              @"sequenceNumber" : @2 }),
                     op);
    KCUAPresentation(@"pip_session_event",
                     event(@{ @"kind" : @"turn-started", @"sessionId" : session,
                              @"turnId" : @"turn-2", @"eventId" : @"e3",
                              @"sequenceNumber" : @3 }),
                     op);
    KCUAPresentation(@"pip_session_event",
                     event(@{ @"kind" : @"focus-changed", @"sessionId" : session,
                              @"revision" : @2 }),
                     op);
    assert(shareRequests == 1);
    // 持有 lease 的回合行为不变。
    leaseOwner = YES;
    observe(@"turn-2");
    assert(shareRequests == 2);

    // 不带回合上下文的观察不登记目标。
    KCUAPresentation(@"pip_session_event",
                     event(@{ @"kind" : @"turn-ended", @"sessionId" : session,
                              @"turnId" : @"turn-2", @"eventId" : @"e4",
                              @"sequenceNumber" : @4 }),
                     op);
    KCUAPresentation(@"pip_session_event",
                     event(@{ @"kind" : @"turn-started", @"sessionId" : session,
                              @"turnId" : @"turn-3", @"eventId" : @"e5",
                              @"sequenceNumber" : @5 }),
                     op);
    KCUAPresentation(@"pip_session_event",
                     event(@{ @"kind" : @"focus-changed", @"sessionId" : session,
                              @"revision" : @3 }),
                     op);
    KCUAPresentationCapture(target, @{});
    assert(shareRequests == 2);

    puts("observe-only turns start the picture-in-picture preview");
  }
  return 0;
}
