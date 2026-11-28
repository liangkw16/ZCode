#import "protocol.h"
// 改变面板或 dismiss 状态的 PiP 方法只属于 presentation 能力（规范 §6.2、§9.4）。
// 修复原因：角色校验原先只列了会话握手与事件两个方法，pip_start / pip_stop /
// pip_clear_dismissed 反而允许工具连接调用；工具连接由模型驱动，不能控制给用户看的画面。
// pip_is_running 只读取状态，不在此列。
bool KCUARequiresPresentation(NSString *method) {
  static NSSet *methods;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    methods = [NSSet setWithArray:@[
      @"pip_session_handshake", @"pip_session_event", @"pip_start", @"pip_stop",
      @"pip_clear_dismissed"
    ]];
  });
  return [methods containsObject:method];
}
