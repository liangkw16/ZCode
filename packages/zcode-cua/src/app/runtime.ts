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
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
} from "../domain/frame.js";
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
      s = { stopped: false, observations: [], epoch: 0 };
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
  async function observe(args: Bag, key: string, s: Session, signal?: AbortSignal) {
    // SDK 每个 cell 只绑定的观察不能淘汰模型已见 token；真正展示或截图仍走新 capture。
    if (args.tree_shown_to_model === false && args.include_screenshot === false)
      await native("application_info", { app_ref: args.app_ref }, key, s, signal);
    const cached = s.observations.find(
      (o) =>
        appMatches(o.state, args.app_ref) &&
        o.generation === ports.broker.generation &&
        o.epoch === ports.broker.epoch(key),
    );
    if (args.tree_shown_to_model === false && args.include_screenshot === false && cached)
      return ok(cached.state);
    const raw = await native(
      "capture_app",
      {
        app_ref: args.app_ref,
        include_screenshot: args.include_screenshot ?? true,
        force_full: true,
        tree_shown_to_model: args.tree_shown_to_model !== false,
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
    state.text = elements
      .map(
        (e: Bag) =>
          `${"  ".repeat(Math.min(e.depth ?? 0, 12))}[${e.index}] ${e.kind ?? e.role}${e.title ? ` ${JSON.stringify(e.title)}` : ""}${e.value !== null && e.value !== undefined ? ` value=${JSON.stringify(e.value)}` : ""}${e.enabled === false ? " disabled" : ""}`,
      )
      .join("\n")
      .slice(0, 48000);
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
    if (raster?.data && !raw.screenshot_blank) {
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
    } else if (raw.screenshot_error || raw.screenshot_blank)
      content.push({
        type: "text",
        text: raw.screenshot_blank
          ? "Screenshot unavailable: uniform frame."
          : `Screenshot unavailable: ${raw.screenshot_error.code}.`,
      });
    return ok(state, content, meta);
  }
  function resolveTarget(
    t: Bag,
    app: Bag,
    s: Session,
  ): { native?: string; point: Bag; guards: Bag } {
    if (t.type === "element") {
      const observation = s.observations.find((o) => appMatches(o.state, app));
      const token = observation?.tokens.get(t.index),
        element = observation?.state.elements[t.index];
      if (!token || !element)
        throw new RequestError("stale_state", "Observe this app before using an element index");
      const b = element.bounds;
      if (!b) throw new RequestError("element_unavailable", "Element has no bounds");
      return { native: token, point: { x: b.x + b.width / 2, y: b.y + b.height / 2 }, guards: {} };
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
      await ports.prepare();
      sync(key, s);
      if (name === "stop_computer_control") {
        await release(key, s);
        return ok({ stopped: true });
      }
      if (name === "get_app_state") return await observe(args, key, s, input.signal);
      if (name === "list_apps")
        return ok({ apps: await native("list_applications", {}, key, s, input.signal) });
      if (name === "list_windows")
        return ok({ windows: await native("list_windows", args, key, s, input.signal) });
      if (name === "request_access") {
        const status = await native("request_access", {}, key, s, input.signal);
        return ok({ status });
      }
      let method: string,
        params: Bag = { app_ref: args.app_ref };
      const target = args.target ? resolveTarget(args.target, args.app_ref, s) : undefined;
      if (name === "left_click") {
        const semantic =
          target?.native &&
          args.strategy !== "event" &&
          (args.mouse_button ?? "left") === "left" &&
          (args.click_count ?? 1) === 1 &&
          !args.modifiers?.length;
        method = semantic ? "element_press" : "click";
        params = {
          ...params,
          ...target?.guards,
          ...(semantic
            ? { native: target!.native }
            : {
                point: target!.point,
                button: args.mouse_button ?? "left",
                clicks: args.click_count ?? 1,
                modifiers: args.modifiers ?? [],
              }),
        };
      } else if (name === "scroll") {
        method = target?.native && args.strategy === "ax" ? "element_scroll" : "scroll";
        params = {
          ...params,
          ...target?.guards,
          ...(method === "element_scroll" ? { native: target!.native } : { point: target!.point }),
          direction: args.scroll_direction,
          amount: args.scroll_amount ?? 1,
        };
      } else if (name === "left_click_drag") {
        const from = resolveTarget(args.from_target, args.app_ref, s),
          to = resolveTarget(args.to, args.app_ref, s);
        method = "drag";
        params = {
          ...params,
          ...from.guards,
          ...to.guards,
          from: from.point,
          to: to.point,
          modifiers: args.modifiers ?? [],
        };
      } else if (["set_value", "select_text", "perform_action"].includes(name)) {
        if (!target?.native)
          throw new RequestError("invalid_request", "Semantic action requires an observed element");
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
            : name === "select_text"
              ? { text_range: args.text_range }
              : { action: args.action }),
        };
      } else if (name === "key") {
        method = args.hold_seconds ? "hold_key_to_app" : "press_key_to_app";
        params = {
          ...params,
          text: args.text,
          ...(args.hold_seconds ? { duration: args.hold_seconds } : {}),
        };
      } else if (name === "type") {
        method = "type_text_to_app";
        params = { ...params, text: args.text };
      } else {
        method = "paste";
        params = { ...params, text: args.text, format: args.format ?? "text" };
      }
      const action = await native(method, params, key, s, input.signal);
      const receipt = {
        schema_version: "zcode-cua-action-receipt-v1",
        action_sent: action?.action_sent === true,
        dispatch_status: action?.dispatch_status ?? "possibly_sent",
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
