#import "protocol.h"
#import <Security/Security.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
static int printJSON(NSDictionary *value) {
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:value
                                                  options:0
                                                    error:nil];
  if (!bytes)
    return 2;
  fwrite(bytes.bytes, 1, bytes.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  return 0;
}
int KCUALifecycleGuard(NSString *directory) {
  if (mkdir(directory.fileSystemRepresentation, 0700) != 0 && errno != EEXIST)
    return 2;
  struct stat st = {};
  if (lstat(directory.fileSystemRepresentation, &st) != 0 ||
      !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 0077))
    return 2;
  NSString *path =
      [directory stringByAppendingPathComponent:@".lifecycle.lock"];
  int fd =
      open(path.fileSystemRepresentation, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (fd < 0)
    return 2;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != getuid() ||
      (st.st_mode & 0077)) {
    close(fd);
    return 2;
  }
  // 互斥归内核所有；Host/guard 崩溃自动释放，不留下无法证明 owner 的空 mkdir
  // 锁。
  while (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    if (errno != EWOULDBLOCK && errno != EAGAIN) {
      close(fd);
      return 2;
    }
    pollfd in = {STDIN_FILENO, POLLIN | POLLHUP, 0};
    if (poll(&in, 1, 10) > 0 && (in.revents & (POLLHUP | POLLERR))) {
      close(fd);
      return 0;
    }
  }
  puts("locked");
  fflush(stdout);
  char byte;
  while (read(STDIN_FILENO, &byte, 1) > 0) {
  }
  flock(fd, LOCK_UN);
  close(fd);
  return 0;
}
static NSDictionary *processFact(pid_t pid) {
  struct proc_bsdinfo info = {};
  if (pid <= 1 ||
      proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) !=
          sizeof(info) ||
      info.pbi_uid != getuid())
    return nil;
  NSString *birth = KCUAProcessBirth(pid), *path = KCUAExecutable(pid);
  if (!birth || !path)
    return nil;
  return @{@"pid" : @(pid), @"birth" : birth, @"executable" : path};
}
int KCUAPrintProcessIdentity(pid_t pid) {
  NSDictionary *fact = processFact(pid);
  return fact ? printJSON(fact) : 2;
}
static NSDictionary *dynamicSigning(pid_t pid) {
  SecCodeRef code = nullptr;
  CFDictionaryRef info = nullptr;
  NSDictionary *attrs = @{(__bridge NSString *)kSecGuestAttributePid : @(pid)};
  if (SecCodeCopyGuestWithAttributes(nullptr, (__bridge CFDictionaryRef)attrs,
                                     kSecCSDefaultFlags,
                                     &code) != errSecSuccess)
    return nil;
  OSStatus valid = SecCodeCheckValidity(code, kSecCSStrictValidate, nullptr);
  if (valid == errSecSuccess)
    SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
  CFRelease(code);
  return CFBridgingRelease(info);
}
int KCUAInspectSocketOwner(NSString *path, NSString *expectedExecutable) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0)
    return 2;
  sockaddr_un address = {};
  address.sun_family = AF_UNIX;
  const char *name = path.fileSystemRepresentation;
  if (strlen(name) >= sizeof(address.sun_path)) {
    close(fd);
    return 2;
  }
  strcpy(address.sun_path, name);
  fcntl(fd, F_SETFL, O_NONBLOCK);
  if (connect(fd, (sockaddr *)&address, sizeof(address)) != 0) {
    if (errno != EINPROGRESS) {
      close(fd);
      return 2;
    }
    pollfd item = {fd, POLLOUT, 0};
    if (poll(&item, 1, 500) <= 0) {
      close(fd);
      return 2;
    }
  }
  int error = 0;
  socklen_t length = sizeof(error);
  if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) != 0 || error) {
    close(fd);
    return 2;
  }
  uid_t uid;
  gid_t gid;
  pid_t pid = 0;
  length = sizeof(pid);
  bool valid = getpeereid(fd, &uid, &gid) == 0 && uid == getuid() &&
               getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0;
  close(fd);
  if (!valid)
    return 2;
  NSDictionary *fact = processFact(pid), *peer = dynamicSigning(pid);
  if (!fact || ![fact[@"executable"] isEqual:expectedExecutable] ||
      ![peer[(__bridge NSString *)kSecCodeInfoIdentifier]
          isEqual:@"dev.zcode.cua-helper.kcode"])
    return 2;
  SecStaticCodeRef disk = nullptr;
  CFDictionaryRef diskInfo = nullptr;
  if (SecStaticCodeCreateWithPath(
          (__bridge CFURLRef)[NSURL fileURLWithPath:expectedExecutable],
          kSecCSDefaultFlags, &disk) != errSecSuccess)
    return 2;
  OSStatus status =
      SecStaticCodeCheckValidity(disk, kSecCSStrictValidate, nullptr);
  if (status == errSecSuccess)
    SecCodeCopySigningInformation(disk, kSecCSSigningInformation, &diskInfo);
  CFRelease(disk);
  NSDictionary *installed = CFBridgingRelease(diskInfo);
  if (!installed || ![installed[(__bridge NSString *)kSecCodeInfoUnique]
                        isEqual:peer[(__bridge NSString *)kSecCodeInfoUnique]])
    return 2;
  if (![fact[@"birth"] isEqual:KCUAProcessBirth(pid)])
    return 2;
  return printJSON(fact);
}
