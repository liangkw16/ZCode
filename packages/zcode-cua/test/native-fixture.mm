#import <Cocoa/Cocoa.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
@interface KCUAFixture : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTextField *text;
@property(nonatomic, strong) NSButton *check;
@property(nonatomic, strong) NSScrollView *scroll;
@property(nonatomic) NSUInteger submissions;
@end
@implementation KCUAFixture
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.window = [[NSWindow alloc]
      initWithContentRect:NSMakeRect(140, 140, 700, 580)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                          NSWindowStyleMaskResizable
                  backing:NSBackingStoreBuffered
                    defer:NO];
  self.window.title = @"KCode CUA Native Fixture";
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
            @"pid" : @(getpid())
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
