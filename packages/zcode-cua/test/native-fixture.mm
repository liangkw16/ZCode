#import <Cocoa/Cocoa.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>
@interface KCUAFixtureWindow : NSWindow
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *inputEvents;
@property(nonatomic, copy) void (^onDown)(void);
@end
@implementation KCUAFixtureWindow
- (void)sendEvent:(NSEvent *)event {
  NSString *kind;
  switch (event.type) {
  case NSEventTypeKeyDown:
    kind = @"keyDown";
    break;
  case NSEventTypeKeyUp:
    kind = @"keyUp";
    break;
  case NSEventTypeLeftMouseDown:
    kind = @"mouseDown";
    break;
  case NSEventTypeLeftMouseUp:
    kind = @"mouseUp";
    break;
  default:
    break;
  }
  if (kind && self.inputEvents.count < 128)
    [self.inputEvents
        addObject:@{@"type" : kind, @"window" : @(self.windowNumber)}];
  if (self.onDown && (event.type == NSEventTypeKeyDown ||
                      event.type == NSEventTypeLeftMouseDown)) {
    auto notify = self.onDown;
    self.onDown = nil;
    dispatch_async(dispatch_get_main_queue(), notify);
  }
  [super sendEvent:event];
}
@end
@interface KCUAFixture : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) KCUAFixtureWindow *window;
@property(nonatomic, strong) KCUAFixtureWindow *second;
@property(nonatomic, strong) NSTextField *text;
@property(nonatomic, strong) NSButton *check;
@property(nonatomic, strong) NSScrollView *scroll;
@property(nonatomic) NSUInteger submissions;
@property(nonatomic, strong) dispatch_source_t focusOriginal;
@property(nonatomic, strong) dispatch_source_t focusSibling;
@property(nonatomic, strong) dispatch_source_t hideFixture;
@end
@implementation KCUAFixture
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.window = [[KCUAFixtureWindow alloc]
      initWithContentRect:NSMakeRect(140, 140, 700, 580)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                          NSWindowStyleMaskResizable
                  backing:NSBackingStoreBuffered
                    defer:NO];
  self.window.title = @"KCode CUA Native Fixture";
  self.window.inputEvents = [NSMutableArray array];
  NSView *view = self.window.contentView;
  NSTextField *label =
      [NSTextField labelWithString:@"KCode source native acceptance"];
  label.frame = NSMakeRect(24, 530, 500, 24);
  [view addSubview:label];
  self.text = [[NSTextField alloc] initWithFrame:NSMakeRect(24, 480, 620, 32)];
  self.text.placeholderString = @"输入中文和 emoji";
  self.text.accessibilityIdentifier = @"fixture-text";
  self.text.accessibilityLabel = @"Fixture text";
  [view addSubview:self.text];
  self.check = [NSButton checkboxWithTitle:@"Confirm fixture"
                                    target:nil
                                    action:nil];
  self.check.frame = NSMakeRect(24, 430, 250, 30);
  self.check.accessibilityIdentifier = @"fixture-checkbox";
  [view addSubview:self.check];
  self.scroll =
      [[NSScrollView alloc] initWithFrame:NSMakeRect(24, 80, 620, 330)];
  self.scroll.hasVerticalScroller = YES;
  NSView *document = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 2400)];
  for (NSUInteger i = 0; i < 60; i++) {
    NSTextField *line = [NSTextField
        labelWithString:[NSString stringWithFormat:@"Scrollable native row %lu",
                                                   (unsigned long)i]];
    line.frame = NSMakeRect(12, 2350 - i * 38, 550, 24);
    [document addSubview:line];
  }
  self.scroll.documentView = document;
  [document scrollPoint:NSMakePoint(0, 2400)];
  [view addSubview:self.scroll];
  NSButton *submit = [NSButton buttonWithTitle:@"Submit fixture"
                                        target:self
                                        action:@selector(submit:)];
  submit.frame = NSMakeRect(24, 24, 180, 32);
  submit.accessibilityIdentifier = @"fixture-submit";
  [view addSubview:submit];
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--dual-window"]) {
    self.second = [[KCUAFixtureWindow alloc]
        initWithContentRect:NSMakeRect(855, 190, 300, 320)
                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                    backing:NSBackingStoreBuffered
                      defer:NO];
    self.second.title = @"KCode CUA Sibling Fixture";
    self.second.inputEvents = [NSMutableArray array];
    [self.second orderFront:nil];
    if ([NSProcessInfo.processInfo.arguments
            containsObject:@"--switch-sibling"]) {
      __weak KCUAFixtureWindow *sibling = self.second;
      self.window.onDown = ^{
        [sibling makeKeyAndOrderFront:nil];
      };
    }
    // 只用于夹具验收。双窗测试脚本可让同一应用回到原窗口再验证恢复。
    signal(SIGUSR1, SIG_IGN);
    self.focusOriginal = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR1, 0, dispatch_get_main_queue());
    __weak KCUAFixtureWindow *original = self.window;
    dispatch_source_set_event_handler(self.focusOriginal, ^{
      [NSApp unhideWithoutActivation];
      [original makeKeyAndOrderFront:nil];
    });
    dispatch_resume(self.focusOriginal);
    signal(SIGUSR2, SIG_IGN);
    self.focusSibling = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR2, 0, dispatch_get_main_queue());
    __weak KCUAFixtureWindow *sibling = self.second;
    dispatch_source_set_event_handler(self.focusSibling, ^{
      [NSApp activateIgnoringOtherApps:YES];
      [sibling makeKeyAndOrderFront:nil];
    });
    dispatch_resume(self.focusSibling);
    // 按原窗口身份复现无法取图，随后恢复同一窗口以验证旧帧确实已撤销。
    signal(SIGURG, SIG_IGN);
    self.hideFixture = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, SIGURG, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(self.hideFixture, ^{ [NSApp hide:nil]; });
    dispatch_resume(self.hideFixture);
  }
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self startOracle];
}
- (void)submit:(id)sender {
  (void)sender;
  self.submissions++;
}
- (void)startOracle {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    int server = socket(AF_INET, SOCK_STREAM, 0);
    int reuse = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address = {};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(19437);
    if (bind(server, (sockaddr *)&address, sizeof(address)) != 0 ||
        listen(server, 8) != 0) {
      close(server);
      return;
    }
    while (true) {
      int fd = accept(server, nullptr, nullptr);
      if (fd < 0)
        break;
      char request[2048];
      ssize_t count = read(fd, request, sizeof(request));
      if (count > 0) {
        __block NSData *json;
        dispatch_sync(dispatch_get_main_queue(), ^{
          json = [NSJSONSerialization dataWithJSONObject:@{
            @"text" : self.text.stringValue,
            @"checked" : @(self.check.state == NSControlStateValueOn),
            @"scroll_y" : @(self.scroll.contentView.bounds.origin.y),
            @"submissions" : @(self.submissions),
            @"pid" : @(getpid()),
            @"window" : @(self.window.windowNumber),
            @"hidden" : @(NSApp.isHidden),
            @"primary_key" : @(self.window.isKeyWindow),
            @"input_events" : self.window.inputEvents,
            @"sibling_window" : @(self.second.windowNumber),
            @"sibling_key" : @(self.second.isKeyWindow),
            @"sibling_input_events" : self.second.inputEvents ?: @[]
          }
                                                 options:0
                                                   error:nil];
        });
        NSString *header =
            [NSString stringWithFormat:@"HTTP/1.1 200 OK\r\nContent-Type: "
                                       @"application/json\r\nContent-Length: "
                                       @"%lu\r\nConnection: close\r\n\r\n",
                                       (unsigned long)json.length];
        write(fd, header.UTF8String, strlen(header.UTF8String));
        write(fd, json.bytes, json.length);
      }
      close(fd);
    }
    close(server);
  });
}
@end
int main(void) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    KCUAFixture *delegate = [KCUAFixture new];
    app.delegate = delegate;
    [app run];
  }
}
