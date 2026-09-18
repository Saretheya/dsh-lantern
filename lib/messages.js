/**
 * dsh-lantern — 消息构造（Host 半部内部模块）。
 *
 * 把协议层解析出的纯数据，用 DSH 官方工厂函数实例化为 `Message[]`。
 *
 * 为什么用官方工厂而不是手写对象：`Message` 带 brand 类型与冻结语义
 * （`createUserMessage` / `createAssistantMessage` / `createSystemMessage` /
 * `createToolResultMessage`），手写对象会在装配或后续处理中出问题。
 *
 * 图片：`ImageBlock.attachment` 必须是本机 attachments 服务可解析的 durable ref，
 * 因此必须走 `ctx.attachments.saveImages()`（设计文档 §7.5.1b）。
 *
 * @module dsh-lantern/messages
 */
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { parseDataUrl } from './protocol.js'

/** 系统提示的归属插件名（用于 source 标记）。 */
const PLUGIN_ID = 'dsh-lantern'

/**
 * 把协议层解析出的 turns 转成 DSH Message[]。
 *
 * @param parsed - `parseChatRequest()` 的返回值。
 * @param attachments - 可选的 attachments 服务（用于图片落引用）。
 * @param options - `{ allowImage, ledger }`：
 *   `allowImage` 是网关开关（§7.5 档 A/B）；
 *   `ledger` 是附件账本（P8）——**传入时图片经账本写入**，从而能被安全回收；
 *   不传则退回直接 `saveImages()`（无回收，仅用于无账本场景）。
 * @returns `{ messages, imageRefs, warnings, degraded }`。
 */
export async function buildMessages(parsed, attachments, options = {}) {
  const { allowImage = false, ledger } = options
  const warnings = [...(parsed.warnings ?? [])]
  const imageRefs = []
  let degraded = false

  const messages = []

  // 1) system：DSH 用独立的系统消息承载
  if (typeof parsed.system === 'string' && parsed.system.length > 0) {
    messages.push(createSystemMessage(parsed.system, PLUGIN_ID))
  }

  // 2) 图片：先统一落成本机 durable 引用（一次批量提交，失败不留半截）
  /** @type {Map<string, object>} dataUrl -> attachment ref */
  const imageCache = new Map()
  if (parsed.images.length > 0) {
    if (!allowImage) {
      // 档 A：明确拒绝而不是静默丢弃（§6.5.1 铁律 3）
      throw Object.assign(new Error('网关未开启图片输入（allowImageInput: false）'), {
        lanternCode: 'image_not_allowed',
      })
    }
    if (attachments === undefined) {
      throw Object.assign(new Error('本机附件服务不可用，无法处理图片输入'), {
        lanternCode: 'attachments_unavailable',
      })
    }
    const pending = []
    for (const url of parsed.images) {
      if (imageCache.has(url)) continue
      const decoded = parseDataUrl(url)
      if (decoded === undefined) {
        warnings.push('忽略了不受支持的图片格式（仅支持 data:image/png|jpeg|webp|gif;base64）')
        degraded = true
        continue
      }
      pending.push({ url, decoded })
    }
    if (pending.length > 0) {
      const payload = pending.map((p) => ({ data: p.decoded.data, mediaType: p.decoded.mediaType }))
      // P8：优先走账本（区分新建/复用，只回收自己新建的）
      const refs = ledger !== undefined ? await ledger.save(payload) : await attachments.saveImages(payload)
      for (const [index, item] of pending.entries()) {
        const ref = refs[index]
        if (ref === undefined) continue
        imageCache.set(item.url, ref)
        imageRefs.push(ref)
      }
    }
  }

  // 3) 逐轮构造
  for (const turn of parsed.turns) {
    if (turn.role === 'user') {
      const content = []
      if (turn.text.length > 0) content.push({ type: 'text', text: turn.text })
      // 用户消息携带图片（本插件把图片挂在当轮 user 消息上）
      for (const url of parsed.images) {
        const ref = imageCache.get(url)
        if (ref !== undefined) content.push({ type: 'image', attachment: ref })
      }
      messages.push(createUserMessage({ content }))
      // 图片只挂第一轮，避免重复注入（协议层未区分轮次，保守处理）
      parsed.images.length = 0
      continue
    }

    if (turn.role === 'assistant') {
      const content = []
      if (turn.text.length > 0) content.push({ type: 'text', text: turn.text })
      for (const call of turn.toolCalls ?? []) {
        content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
      }
      messages.push(
        createAssistantMessage({
          content,
          source: { kind: 'model', provider: PLUGIN_ID, model: 'lantern' },
        }),
      )
      continue
    }

    if (turn.role === 'tool') {
      messages.push(
        createToolResultMessage({
          callId: turn.callId,
          content: [{ type: 'text', text: turn.text }],
          isError: false,
        }),
      )
    }
  }

  return { messages, imageRefs, warnings, degraded }
}

/**
 * 把 DSH 的事件级错误映射为对客户端友好的信息，并**先脱敏**。
 *
 * 脱敏红线（设计文档 §6.5.10-b）：上游错误可能回显 key / 邮箱 / 端点，
 * 原文照显前必须掩码。这里做的是"不改语义、只掩码"。
 *
 * @param message - 原始错误消息。
 * @returns 脱敏后的消息。
 */
export function maskSecrets(message) {
  return String(message ?? '')
    .replace(/\b(sk|npm|ghp|xoxb|glm|hf)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***')
}
