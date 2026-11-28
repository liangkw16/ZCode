export class CuaHelperLifecycleManager<Managed> {
  private current: Managed | undefined;
  private ended = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly release?: (managed: Managed) => Promise<void> | void) {}
  acquire(options: {
    isAdmitted?: () => boolean;
    shouldRetainCurrent?: (current: Managed) => boolean;
    create: () => Managed | undefined;
  }): Promise<Managed | undefined> {
    const work = this.tail.then(async () => {
      if (this.ended || options.isAdmitted?.() === false) return undefined;
      if (this.current && (options.shouldRetainCurrent?.(this.current) ?? true))
        return this.current;
      if (this.current) await this.release?.(this.current);
      this.current = options.create();
      return this.current;
    });
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  peek() {
    return this.current;
  }
  get disposed() {
    return this.ended;
  }
  async dispose(managed?: Managed) {
    // admission 立即关闭；排空先前 acquire 后只释放当前实例一次，避免异步 dispose 复活 Host。
    this.ended = true;
    const work = this.tail.then(async () => {
      const target = managed ?? this.current;
      if (target && target === this.current) {
        this.current = undefined;
        await this.release?.(target);
      }
    });
    this.tail = work.catch(() => {});
    await work;
  }
}
