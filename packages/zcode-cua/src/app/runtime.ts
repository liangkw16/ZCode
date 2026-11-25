import type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
  ComputerUseRuntimeExecuteInput,
  RuntimePorts,
} from "../contract/index.js";
import {
  validateRequest,
  sessionKey,
  appMatches,
  RequestError,
  type Bag,
} from "../domain/request.js";
import {
  decodeFrameBase64,
  readRasterEnvelopeIdentity,
  sha256Hex,
  truncateUtf16,
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
} from "../domain/frame.js";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "../../request-access-contract.js";
interface Observation {
  state: Bag;
  tokens: Map<number, string>;
  generation?: string;
  epoch: number;
}
interface Session {
  stopped: boolean;
  released?: boolean;
  releasing?: Promise<void>;
  observations: Observation[];
  frame?: {
    id: string;
    raw: Bag;
    width: number;
    height: number;
    generation?: string;
    epoch: number;
  };
  frameRequest?: object;
  activeInputs: number;
  generation?: string;
  epoch: number;
}
export function createRuntime(ports: RuntimePorts): ComputerUseRuntime {
  const sessions = new Map<string, Session>();
  let disposed = false;
  const ok = (
    value: Bag,
    content: any[] = [{ type: "text", text: JSON.stringify(value) }],
    meta?: Bag,
  ) => ({ content, structuredContent: value, ...(meta ? { _meta: meta } : {}) });
  const failure = (error: unknown) => {
    const e = error as { code?: string; message?: string; details?: Bag };
    const details = e.details ?? {};
    const sent = details.action_sent === true || details.dispatch_status === "possibly_sent";
    return {
      isError: true,
      ...ok({
        error: {
          code: e.code ?? "internal",
          message: e.message ?? "Computer-use request failed",
          details,
        },
        action_receipt: {
          schema_version: "zcode-cua-action-receipt-v1",
          action_sent: sent,
          dispatch_status: details.dispatch_status ?? (sent ? "possibly_sent" : "not_sent"),
          retry_action: false,
        },
      }),
    };
  };
  const getSession = (key: string) => {
    let s = sessions.get(key);
    if (!s) {
      s = { stopped: false, observations: [], activeInputs: 0, epoch: 0 };
      sessions.set(key, s);
    }
    return s;
  };
  const invalidate = (s: Session) => {
    s.observations = [];
    s.frame = undefined;
  };
  const sync = (key: string, s: Session) => {
    const generation = ports.broker.generation,
      epoch = ports.broker.epoch(key);
    if ((s.generation !== undefined && s.generation !== generation) || s.epoch !== epoch)
      invalidate(s);
    s.generation = generation;
    s.epoch = epoch;
  };
  async function native(
    method: string,
    params: Bag,
    key: string,
    s: Session,
    signal?: AbortSignal,
  ) {
    try {
      return await ports.broker.call<any>(method, params, { session: key, signal });
    } finally {
      sync(key, s);
    }
  }
  async function observe(
    args: Bag,
    key: string,
    s: Session,
    signal?: AbortSignal,
    context?: ComputerUseRuntimeContext,
  ) {
    // 沿用旧契约与 SDK 文档：缺省不截图。纯 AX 观察不产生新帧，也不撤销此前仍有效的像素帧；
    // 坐标目标绑定的是会话最近一次可操作的栅格。
    const includesPixels = args.include_screenshot ?? false;
    const frameRequest = includesPixels && s.activeInputs === 0 ? {} : undefined;
    if (includesPixels) {
      // 新的取图请求一旦开始就撤销旧坐标。空白、失败或迟到的旧响应不能恢复它。
      s.frame = undefined;
      s.frameRequest = frameRequest;
    }
    // 隐藏绑定只验证已有缓存；无缓存时直接 capture_app，保留显式 getApp 拉起应用的能力。
    const cachedState = () =>
      s.observations.find(
        (o) =>
          appMatches(o.state, args.app_ref) &&
          o.generation === ports.broker.generation &&
          o.epoch === ports.broker.epoch(key),
      );
    const cached = cachedState();
    if (args.tree_shown_to_model === false && args.include_screenshot === false && cached) {
      // 修复原因：application_info 的返回值原先被丢弃。应用已退出（native 返回 null）或 PID 已变时，
      // 隐式绑定仍会带着旧缓存成功返回；现在改走一次完整观察。这次 native 调用可能带回新的 epoch，
      // 所以调用之后还要确认缓存仍是当前代际的那一份。
      const app = await native("application_info", { app_ref: args.app_ref }, key, s, signal);
      if (app && app.pid === cached.state.app.pid && cachedState() === cached)
        return ok(cached.state);
    }
    const raw = await native(
      "capture_app",
      {
        app_ref: args.app_ref,
        include_screenshot: includesPixels,
        force_full: true,
        tree_shown_to_model: args.tree_shown_to_model !== false,
        ...(args.tree_shown_to_model === false && args.include_screenshot === true
          ? { pixels_only: true }
          : {}),
        ...(context?.turnId
          ? { pip_session_context: { session_id: context.sessionId, turn_id: context.turnId } }
          : {}),
      },
      key,
      s,
      signal,
    );
    if (
      !raw ||
      !raw.app ||
      !raw.window ||
      !Array.isArray(raw.elements) ||
      raw.snapshot_mode !== "full"
    )
      throw new RequestError("invalid_response", "Helper did not return a full app observation");
    const tokens = new Map<number, string>();
    const elements = raw.elements.map((item: Bag, index: number) => {
      if (typeof item.native !== "string")
        throw new RequestError("invalid_response", "Missing native element handle");
      tokens.set(index, item.native);
      const { native: _native, owner_pid: _owner, ...visible } = item;
      return { ...visible, index };
    });
    const state: Bag = {
      state_id: `state-${ports.id()}`,
      app: raw.app,
      window: raw.window,
      elements,
      snapshot_mode: "full",
      truncated: raw.truncated === true,
    };
    // 修复原因：这里原先按 UTF-16 码元硬截断（slice(0, 48000)），标题或值里的 emoji、
    // 生僻字可能被切成半个代理项，provider 收到孤立代理项直接拒绝整个请求（500）；
    // 适配层的 toWellFormed 兜底只修发往 provider 的副本，落盘历史仍带半个字符。
    state.text = truncateUtf16(
      elements
        .map(
          (e: Bag) =>
            `${"  ".repeat(Math.min(e.depth ?? 0, 12))}[${e.index}] ${e.kind ?? e.role}${e.title ? ` ${JSON.stringify(e.title)}` : ""}${e.value !== null && e.value !== undefined ? ` value=${JSON.stringify(e.value)}` : ""}${e.enabled === false ? " disabled" : ""}`,
        )
        .join("\n"),
      48_000,
    );
    const observation: Observation = {
      state,
      tokens,
      generation: ports.broker.generation,
      epoch: ports.broker.epoch(key),
    };
    if (args.tree_shown_to_model !== false) {
      s.observations = s.observations.filter(
        (o) =>
          !(
            o.state.app.pid === state.app.pid && o.state.window.window_id === state.window.window_id
          ),
      );
      s.observations.unshift(observation);
      if (s.observations.length > 16) s.observations.length = 16;
    }
    const content: any[] = [{ type: "text", text: state.text }];
    let meta: Bag | undefined;
    const raster = raw.screenshot;
    if (raster?.data && !raw.screenshot_blank && frameRequest &&
        s.frameRequest === frameRequest && !s.stopped) {
      const bytes = decodeFrameBase64(raster.data),
        identity = bytes && readRasterEnvelopeIdentity(bytes);
      const mime =
        raster.format === "png"
          ? "image/png"
          : raster.format === "jpeg" || raster.format === "jpg"
            ? "image/jpeg"
            : undefined;
      const bounds = raw.pointer ?? raw.screenshot_bounds;
      if (
        !bytes ||
        !identity ||
        identity.mimeType !== mime ||
        identity.width !== raster.width ||
        identity.height !== raster.height ||
        !bounds ||
        ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        !raw.surface_identity
      )
        throw new RequestError("invalid_response", "Native raster provenance is incomplete");
      const frameId = `frame-${ports.id()}`;
      s.frame = {
        id: frameId,
        raw,
        width: raster.width,
        height: raster.height,
        generation: ports.broker.generation,
        epoch: ports.broker.epoch(key),
      };
      content.push(
        { type: "image", data: raster.data, mimeType: mime },
        {
          type: "text",
          text: JSON.stringify({
            image_ref: {
              frame_id: frameId,
              width: raster.width,
              height: raster.height,
              actionable: true,
            },
          }),
        },
      );
      meta = {
        [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {
          version: 1,
          frame_id: frameId,
          width: raster.width,
          height: raster.height,
          media_type: mime,
          sha256: sha256Hex(bytes),
        },
      };
    } else if (includesPixels)
      content.push({
        type: "text",
        text: raw.screenshot_blank
          ? "Screenshot unavailable: uniform frame."
          : raw.screenshot_error
            ? `Screenshot unavailable: ${raw.screenshot_error.code}.`
            : raster?.data
              ? "Screenshot unavailable: observation was superseded or input was in progress."
              : "Screenshot unavailable: no raster returned.",
      });
    return ok(state, content, meta);
  }
  function resolveTarget(
    t: Bag,
    app: Bag,
    s: Session,
  ): { native?: string; point: Bag; guards: Bag; appRef: Bag; canPress?: boolean } {
    if (t.type === "element") {
      const observation = s.observations.find((o) => appMatches(o.state, app));
      const token = observation?.tokens.get(t.index),
        element = observation?.state.elements[t.index];
      if (!token || !element)
        throw new RequestError("stale_state", "Observe this app before using an element index");
      const b = element.bounds;
      if (!b) throw new RequestError("element_unavailable", "Element has no bounds");
      return {
        native: token,
        point: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
        guards: {},
        appRef: { pid: observation!.state.app.pid, window_id: observation!.state.window.window_id },
        canPress: Array.isArray(element.actions) && element.actions.includes("AXPress"),
      };
    }
    const f = s.frame;
    if (
      !f ||
      (t.frame_id !== undefined && t.frame_id !== f.id) ||
      !appMatches(f.raw, app) ||
      f.generation !== ports.broker.generation ||
      f.epoch !== s.epoch ||
      t.x >= f.width ||
      t.y >= f.height
    )
      throw new RequestError(
        "stale_state",
        "Coordinate requires the latest delivered frame from this session and app",
      );
    const b = f.raw.pointer ?? f.raw.screenshot_bounds;
    return {
      appRef: { pid: f.raw.app.pid, window_id: f.raw.window.window_id },
      point: { x: b.x + (t.x * b.width) / f.width, y: b.y + (t.y * b.height) / f.height },
      guards: {
        expected_pid: f.raw.app.pid,
        expected_window_id: f.raw.window.window_id,
        expected_window_bounds: f.raw.window.bounds,
        expected_desktop_epoch: f.raw.desktop_epoch,
        expected_cancellation_epoch: f.raw.cancellation_epoch,
      },
    };
  }
  async function execute(input: ComputerUseRuntimeExecuteInput) {
    try {
      if (disposed) throw new RequestError("unavailable", "Computer-use runtime is disposed");
      const key = sessionKey(input.context),
        args = validateRequest(input.toolName, input.arguments),
        s = getSession(key),
        name = input.toolName;
      if (s.stopped && name !== "stop_computer_control")
        throw new RequestError("stopped", "Computer control is stopped for this logical session");
      if (input.signal?.aborted)
        throw new RequestError("cancelled", "Request cancelled before dispatch");
      // 修复原因：停止标记原先要等 Helper 准备成功、native 清理完成才生效。准备失败时 stop 请求报错，
      // 标记却没有落下，同一会话随后仍能继续派发输入。现在先同步关闭本会话的 admission，再做可重试的清理。
      if (name === "stop_computer_control") s.stopped = true;
      await ports.prepare();
      sync(key, s);
      // 等待 prepare() 期间到达的 stop 同样生效：派发前复核。
      if (s.stopped && name !== "stop_computer_control")
        throw new RequestError("stopped", "Computer control is stopped for this logical session");
      if (name === "stop_computer_control") {
        await release(key, s);
        return ok({ stopped: true });
      }
      if (name === "get_app_state") return await observe(args, key, s, input.signal, input.context);
      if (name === "list_apps")
        return ok({ apps: await native("list_applications", {}, key, s, input.signal) });
      if (name === "list_windows")
        return ok({ windows: await native("list_windows", args, key, s, input.signal) });
      if (name === "request_access") {
        // 修复原因：返回值原先包成 { status }，而 SDK 的 requestAccess() 直接把首个文本块解析成
        // AccessStatus（ready / accessibility / screenRecording），三项读出来都是 undefined；桌面
        // 的权限观察只读 _meta 里的权限事实，原先也从未写入，授权引导因此不会出现。
        // native 始终申请全部权限，capabilities 只做校验。
        const report = await native("request_access", {}, key, s, input.signal);
        const known = (value: unknown) =>
          value === "granted" || value === "denied" ? value : "unknown";
        const accessibility = known(report?.accessibility);
        const screenRecording = known(report?.screen_recording);
        const facts = cuaRequestAccessStatusSchema.safeParse({
          schemaVersion: 1,
          platform: "darwin",
          grantOwner: report?.grant_owner,
          accessibility,
          screenRecording,
        });
        return ok(
          {
            ready: accessibility === "granted" && screenRecording === "granted",
            accessibility,
            screenRecording,
            ...(report?.desktop_availability === "locked"
              ? { message: "The desktop is locked; unlock it to continue." }
              : {}),
          },
          undefined,
          facts.success ? { [CUA_REQUEST_ACCESS_STATUS_META_KEY]: facts.data } : undefined,
        );
      }
      let method: string,
        params: Bag = { app_ref: args.app_ref };
      const target = args.target ? resolveTarget(args.target, args.app_ref, s) : undefined;
      if (target) params.app_ref = target.appRef;
      if (name === "left_click") {
        const semantic =
          target?.native &&
          (args.strategy === "ax" || target.canPress) &&
          args.strategy !== "event" &&
          (args.mouse_button ?? "left") === "left" &&
          (args.click_count ?? 1) === 1 &&
          !args.modifiers?.length;
        // 文档约定显式 strategy 强制走那一条路径：点名 a11y 却没有可按的元素时不静默改发事件。
        if (args.strategy === "ax" && !semantic)
          throw new RequestError(
            "invalid_request",
            "left_click strategy a11y needs an element that supports AXPress, a single left click and no modifiers",
          );
        method = semantic ? "element_press" : "click";
        params = {
          ...params,
          ...target?.guards,
          ...(semantic
            ? { native: target!.native }
            : {
                point: target!.point,
                ...(target!.native ? { native_target: target!.native } : {}),
                button: args.mouse_button ?? "left",
                clicks: args.click_count ?? 1,
                modifiers: args.modifiers ?? [],
              }),
        };
      } else if (name === "scroll") {
        if (args.strategy === "ax" && !target?.native)
          throw new RequestError("invalid_request", "scroll strategy a11y needs an element target");
        method = target?.native && args.strategy === "ax" ? "element_scroll" : "scroll";
        params = {
          ...params,
          ...target?.guards,
          ...(method === "element_scroll"
            ? { native: target!.native }
            : {
                point: target!.point,
                ...(target!.native ? { native_target: target!.native } : {}),
              }),
          direction: args.scroll_direction,
          amount: args.scroll_amount ?? 1,
        };
      } else if (name === "left_click_drag") {
        const from = resolveTarget(args.from_target, args.app_ref, s),
          to = resolveTarget(args.to, args.app_ref, s);
        if (from.appRef.pid !== to.appRef.pid || from.appRef.window_id !== to.appRef.window_id)
          throw new RequestError(
            "invalid_request",
            "Drag endpoints must belong to the same verified window",
          );
        if (args.strategy === "ax")
          throw new RequestError("invalid_request", "drag only sends input events; strategy a11y is not supported");
        method = "drag";
        params = {
          ...params,
          ...from.guards,
          ...to.guards,
          app_ref: from.appRef,
          from: from.point,
          to: to.point,
          ...(from.native ? { from_native: from.native } : {}),
          ...(to.native ? { to_native: to.native } : {}),
          modifiers: args.modifiers ?? [],
        };
      } else if (["set_value", "select_text", "perform_action"].includes(name)) {
        if (!target?.native)
          throw new RequestError("invalid_request", "Semantic action requires an observed element");
        // 三个动作都只走辅助功能路径；公开签名里只有 set_value 接受 strategy。
        if (name === "set_value" && args.strategy === "event")
          throw new RequestError(
            "invalid_request",
            "set_value only works through the accessibility path; strategy event is not supported",
          );
        method = {
          set_value: "element_set_value",
          select_text: "element_select_text",
          perform_action: "element_perform_action",
        }[name]!;
        params = {
          ...params,
          native: target.native,
          ...(name === "set_value"
            ? { value: args.value }
            : name === "perform_action"
              ? { action: args.action }
              : {}),
        };
        // 文档约定不带 text_range 时选中整个值。长度由原生层按元素当前值计算：观测到的值会被截到
        // 16,384 个码元，按它算会漏选尾部。
        if (name === "select_text" && args.text_range !== undefined)
          params.text_range = args.text_range;
      } else if (name === "key") {
        if (args.strategy === "ax")
          throw new RequestError("invalid_request", "key only sends input events; strategy a11y is not supported");
        method = args.hold_seconds ? "hold_key_to_app" : "press_key_to_app";
        params = {
          ...params,
          text: args.text,
          ...(args.hold_seconds ? { duration: args.hold_seconds } : {}),
        };
      } else if (name === "type") {
        if (args.strategy === "ax")
          throw new RequestError("invalid_request", "type only sends input events; strategy a11y is not supported");
        // 文档约定 type 可带 target。定位与输入交给同一次原生操作完成：Host 侧拆成两步时，并发调用
        // 会交错成“聚焦 A → 聚焦 B → 输入 A 的文本”，两段文本都落进 B。
        // 缺省用 AX 聚焦元素；显式 event 改为点击元素当前位置，不碰辅助功能焦点；坐标目标先点击。
        if (target) {
          if (target.native) {
            params[args.strategy === "event" ? "click_native" : "focus_native"] =
              target.native;
          } else {
            Object.assign(params, target.guards, { click_point: target.point });
          }
        }
        method = "type_text_to_app";
        params = { ...params, text: args.text };
      } else {
        method = "paste";
        params = { ...params, text: args.text, format: args.format ?? "text" };
      }
      // 动作可能改变像素内容，即使窗口几何未变。拖动起终点已在同一帧完成校验。
      s.frame = undefined;
      s.frameRequest = undefined;
      s.activeInputs++;
      // 修复原因：多步骤动作（key 的 repeat）只保留最后一步的结果。第一步已发送、后一步在派发前
      // 后一步在派发前取消或失败时，整次回执会报成 action_sent:false / not_sent，调用方据此以为
      // 界面还没收到按键而重发。这里累计每一步的派发事实。
      let dispatched = false;
      let lastStatus: string | undefined;
      const dispatch = async (stepMethod: string, stepParams: Bag) => {
        try {
          const result = await native(stepMethod, stepParams, key, s, input.signal);
          dispatched ||=
            result?.action_sent === true || result?.dispatch_status === "possibly_sent";
          lastStatus = result?.dispatch_status;
          return result;
        } catch (error) {
          if (!dispatched) throw error;
          const e = error as { code?: string; message?: string; details?: Bag };
          throw Object.assign(new Error(e.message ?? "Computer-use request failed"), {
            code: e.code ?? "internal",
            details: {
              ...(e.details ?? {}),
              action_sent: true,
              dispatch_status: "possibly_sent",
              partial_dispatch: true,
            },
          });
        }
      };
      let action;
      try {
        // 文档约定 key 用 repeat 重发和弦；全部重发计入同一次在途输入。
        for (let i = 1; i < (args.repeat ?? 1); i++) await dispatch(method, params);
        action = await dispatch(method, params);
      } finally {
        s.activeInputs--;
      }
      const receipt = {
        schema_version: "zcode-cua-action-receipt-v1",
        action_sent: dispatched || action?.action_sent === true,
        dispatch_status:
          dispatched && lastStatus === "not_sent"
            ? "possibly_sent"
            : (action?.dispatch_status ?? "possibly_sent"),
        retry_action: false,
      };
      const result = ok({ action_receipt: receipt });
      if (!args.return_state || args.return_state === "none") return result;
      try {
        const observed = await observe(
          { app_ref: args.app_ref, include_screenshot: false },
          key,
          s,
          input.signal,
          input.context,
        );
        return {
          ...observed,
          content: [...result.content, ...observed.content],
          structuredContent: { ...observed.structuredContent, action_receipt: receipt },
        };
      } catch {
        return ok({ action_receipt: receipt, state_unavailable: true });
      }
    } catch (error) {
      return failure(error);
    }
  }
  async function release(key: string, s: Session) {
    s.stopped = true;
    invalidate(s);
    if (s.released) return;
    if (!s.releasing)
      s.releasing = ports.broker
        .call("session_release", {}, { session: key })
        .then(() => {
          s.released = true;
        })
        .finally(() => {
          s.releasing = undefined;
        });
    await s.releasing;
  }
  async function closeSession(context: ComputerUseRuntimeContext) {
    const key = sessionKey(context),
      s = sessions.get(key);
    if (!s) return;
    await release(key, s);
  }
  return {
    execute,
    closeSession,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all([...sessions.entries()].map(([key, s]) => release(key, s))).finally(() =>
        ports.broker.close(),
      );
    },
  };
}
