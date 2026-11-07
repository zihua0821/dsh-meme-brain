// dsh-meme-brain · Web 界面（薄视图）
//
// 铁律（G-2 / ADR-0005）：这里只做三件事——取 JSON、渲染、发操作。
// 不做筛选逻辑、不判重、不猜状态；所有数据都来自 /meme-brain/api。
// 任何这里挂掉的情况，最多是页面难看，命令仍然可用。

window.__ModuleLoader__.load({
  id: 'dsh-meme-brain',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/meme-brain/api'

    async function get(params) {
      const qs = new URLSearchParams(params).toString()
      const res = await fetch(`${API}?${qs}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error?.message || json.error?.code || '请求失败')
      return json.data
    }

    async function post(params, body) {
      const qs = new URLSearchParams(params).toString()
      const res = await fetch(`${API}?${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error?.message || json.error?.code || '保存失败')
      return json.data
    }

    const border = '1px solid rgba(128,128,128,0.28)'
    const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    // 评分维度与提示词锚点一一对应；标签只做展示，不参与任何判断
    const SCORE_DIMS = [
      { key: 'valence', label: '情绪', min: -1, max: 1, center: true },
      { key: 'arousal', label: '强度', min: 0, max: 1 },
      { key: 'aggression', label: '攻击', min: 0, max: 1 },
      { key: 'intimacy', label: '亲密', min: 0, max: 1 },
      { key: 'absurdity', label: '抽象', min: 0, max: 1 },
    ]

    const CONF_COLOR = { 高: 'rgba(70,170,110,0.9)', 中: 'rgba(210,160,60,0.9)', 低: 'rgba(128,128,128,0.7)' }

    const stamp = (ts) => (ts ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '—')

    function Chip({ children }) {
      return h('span', {
        style: { padding: '1px 7px', borderRadius: 999, border, fontSize: 11, lineHeight: '16px', display: 'inline-block' },
      }, children)
    }

    function Section({ title, children }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 } },
        h('div', {
          style: { fontSize: 10, letterSpacing: 1, opacity: 0.45, textTransform: 'uppercase', borderBottom: border, paddingBottom: 3 },
        }, title),
        children,
      )
    }

    function Meter({ dim, value }) {
      const has = typeof value === 'number' && Number.isFinite(value)
      const pct = has ? Math.min(100, Math.max(0, ((value - dim.min) / (dim.max - dim.min)) * 100)) : 0
      const zero = dim.center ? 50 : 0
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '18px' } },
        h('span', { style: { width: 32, opacity: 0.6, flex: 'none' } }, dim.label),
        h('div', {
          style: { position: 'relative', flex: 1, height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.22)', overflow: 'hidden' },
        },
          h('div', {
            style: {
              position: 'absolute', top: 0, bottom: 0, borderRadius: 3,
              left: `${Math.min(zero, pct)}%`, width: `${Math.abs(pct - zero)}%`,
              background: has ? 'rgba(77,107,254,0.85)' : 'transparent',
            },
          }),
        ),
        h('span', {
          style: { width: 36, textAlign: 'right', fontFamily: mono, fontSize: 11, flex: 'none', opacity: has ? 0.85 : 0.35 },
        }, has ? value.toFixed(2) : '—'),
      )
    }

    // 侧栏图标：一个贴纸形状
    function PanelIcon(props) {
      const size = props.size || 18
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 9, cy: 10, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 15, cy: 10, r: 1.5, fill: 'currentColor' }),
        h('path', { d: 'M9 15c1.6 1.4 4.4 1.4 6 0', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function Cell({ item, active, onPick }) {
      const name = item.name || item.md5.slice(0, 8)
      return h(
        'button',
        {
          type: 'button',
          onClick: () => onPick(item.md5),
          title: `${name}\n${item.width}×${item.height} · ${item.ext}`,
          style: {
            display: 'flex', flexDirection: 'column', gap: 4, padding: 6, cursor: 'pointer',
            background: active ? 'rgba(77,107,254,0.14)' : 'transparent',
            border: active ? '1px solid rgba(77,107,254,0.7)' : border,
            borderRadius: 8, color: 'inherit', font: 'inherit', textAlign: 'left',
          },
        },
        h('img', {
          src: item.url, alt: name, loading: 'lazy',
          style: {
            width: '100%', height: 84, objectFit: 'contain', borderRadius: 4,
            background:
              'repeating-conic-gradient(rgba(128,128,128,0.10) 0% 25%, transparent 0% 50%) 50% / 12px 12px',
          },
        }),
        h('span', {
          style: { fontSize: 11, lineHeight: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, name),
        item.character
          ? h('span', {
            style: { fontSize: 10, lineHeight: '13px', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, item.character)
          : null,
      )
    }

    function Detail({ md5, onSaved }) {
      const [item, setItem] = useState(null)
      const [name, setName] = useState('')
      const [tags, setTags] = useState('')
      const [msg, setMsg] = useState('')

      useEffect(() => {
        let alive = true
        setItem(null)
        setMsg('')
        get({ op: 'item', md5 })
          .then((d) => {
            if (!alive) return
            setItem(d)
            setName(d.name || '')
            setTags(d.tags || '')
          })
          .catch((e) => alive && setMsg(e.message))
        return () => { alive = false }
      }, [md5])

      const save = useCallback(async () => {
        try {
          await post({ op: 'annotate' }, { md5, name, tags })
          setMsg('已保存')
          onSaved?.()
        } catch (e) {
          setMsg(e.message)
        }
      }, [md5, name, tags, onSaved])

      if (msg && !item) return h('div', { style: { padding: 12, fontSize: 12, opacity: 0.7 } }, msg)
      if (!item) return h('div', { style: { padding: 12, fontSize: 12, opacity: 0.7 } }, '载入中…')

      const row = (k, v, w = 56) => h('div', { style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '20px' } },
        h('span', { style: { width: w, opacity: 0.6, flex: 'none' } }, k),
        h('span', { style: { wordBreak: 'break-all', flex: 1, minWidth: 0 } }, v))

      const score = item.score || {}
      const scenes = String(item.scene || '').split(',').map((s) => s.trim()).filter(Boolean)
      const chars = String(item.character || '')

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('img', {
          src: item.url, alt: item.name || item.md5,
          style: {
            width: '100%', maxHeight: 240, objectFit: 'contain', borderRadius: 8, border,
            background:
              'repeating-conic-gradient(rgba(128,128,128,0.10) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
          },
        }),

        h('label', { style: { fontSize: 12, opacity: 0.7 } }, '名字'),
        h('input', {
          value: name, onChange: (e) => setName(e.target.value),
          placeholder: '给她看的短名',
          style: { padding: '6px 8px', borderRadius: 6, border, background: 'transparent', color: 'inherit', font: 'inherit' },
        }),
        h('label', { style: { fontSize: 12, opacity: 0.7 } }, '标签（逗号分隔）'),
        h('input', {
          value: tags, onChange: (e) => setTags(e.target.value),
          placeholder: '卖萌,干饭',
          style: { padding: '6px 8px', borderRadius: 6, border, background: 'transparent', color: 'inherit', font: 'inherit' },
        }),
        h('button', {
          type: 'button', onClick: save,
          style: {
            padding: '6px 10px', borderRadius: 6, border, background: 'rgba(77,107,254,0.14)',
            color: 'inherit', font: 'inherit', cursor: 'pointer', alignSelf: 'flex-start',
          },
        }, '保存'),
        msg ? h('div', { style: { fontSize: 12, opacity: 0.7 } }, msg) : null,

        Section({ title: '分析结果',
          children: [
            row('角色', chars
              ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                chars,
                h('span', {
                  style: {
                    fontSize: 10, lineHeight: '15px', padding: '0 5px', borderRadius: 999,
                    border: `1px solid ${CONF_COLOR[item.charConf] || 'rgba(128,128,128,0.5)'}`,
                    color: CONF_COLOR[item.charConf] || 'inherit', opacity: item.charConf ? 1 : 0.5,
                  },
                }, `把握 ${item.charConf || '?'}`))
              : h('span', { style: { opacity: 0.45 } }, '未知')),
            row('外观', item.appearance || h('span', { style: { opacity: 0.45 } }, '—')),
            row('场景', scenes.length
              ? h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, scenes.map((s, i) => h(Chip, { key: i }, s)))
              : h('span', { style: { opacity: 0.45 } }, '—')),
            row('指向', item.target || h('span', { style: { opacity: 0.45 } }, '—')),
            row('图上文字', item.text || h('span', { style: { opacity: 0.45 } }, '—')),
          ] }),

        item.analyzed
          ? Section({ title: '评分', children: SCORE_DIMS.map((d) => h(Meter, { key: d.key, dim: d, value: score[d.key] })) })
          : h('div', { style: { fontSize: 12, opacity: 0.6, padding: '6px 0', lineHeight: '18px' } },
            '还没分析过。会话里运行：', h('code', { style: { fontFamily: mono, fontSize: 11 } }, ` /meme analyze --md5=${item.md5.slice(0, 8)}`)),

        Section({ title: '文件与来源',
          children: [
            row('md5', h('code', { style: { fontFamily: mono } }, item.md5)),
            row('文件', `${item.ext} · ${(item.bytes / 1024).toFixed(0)}KB · ${item.width}×${item.height} · ${item.frames} 帧${item.hasAlpha ? ' · 带透明' : ''}`),
            row('指纹', h('code', { style: { fontFamily: mono, fontSize: 11 } }, item.dhash || '—')),
            row('状态', `${item.state}${item.pinned ? ' · 人工锁定' : ''}`),
            item.dupOf ? row('重复于', `${item.dupOf.slice(0, 8)}（距离 ${item.dupDistance ?? '?'}）`) : null,
            row('来源', item.source || '—'),
            row('入库', stamp(item.createdAt)),
            row('分析', item.analyzedAt ? `${stamp(item.analyzedAt)} · ${item.model || '?'}` : '未分析'),
          ] }),
      )
    }

    function Page() {
      const [q, setQ] = useState('')
      const [draft, setDraft] = useState('')
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(0)
      const [indexed, setIndexed] = useState(true)
      const [limit, setLimit] = useState(60)
      const [picked, setPicked] = useState('')
      const [error, setError] = useState('')

      const load = useCallback(async (query, lim) => {
        try {
          setError('')
          const data = await get({ op: 'list', q: query, limit: lim })
          setItems(data.items)
          setTotal(data.total)
          setIndexed(data.indexed)
        } catch (e) {
          setError(e.message)
        }
      }, [])

      useEffect(() => { load(q, limit) }, [q, limit, load])

      return h('div', {
        style: { display: 'flex', gap: 16, padding: 16, height: '100%', minHeight: 0, boxSizing: 'border-box' },
      },
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              value: draft,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { setLimit(60); setQ(draft.trim()) } },
              placeholder: '搜名字 / 标签 / md5，回车执行',
              style: { flex: 1, padding: '7px 10px', borderRadius: 8, border, background: 'transparent', color: 'inherit', font: 'inherit' },
            }),
            h('button', {
              type: 'button',
              onClick: () => { setLimit(60); setQ(draft.trim()) },
              style: { padding: '7px 12px', borderRadius: 8, border, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
            }, '搜索'),
            h('span', { style: { fontSize: 12, opacity: 0.6, flex: 'none' } }, `共 ${total} 张`),
          ),

          !indexed
            ? h('div', { style: { fontSize: 13, opacity: 0.7, padding: 12 } }, '还没有索引：先运行 /meme import')
            : null,
          error ? h('div', { style: { fontSize: 12, color: '#e05666' } }, error) : null,

          h('div', {
            style: {
              display: 'grid', gap: 8, overflowY: 'auto', paddingRight: 4,
              gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', alignContent: 'start', flex: 1, minHeight: 0,
            },
          },
            items.map((it) => h(Cell, { key: it.md5, item: it, active: picked === it.md5, onPick: setPicked })),
          ),

          items.length && total > items.length
            ? h('button', {
              type: 'button', onClick: () => setLimit((n) => n + 60),
              style: { padding: '6px 10px', borderRadius: 6, border, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', alignSelf: 'flex-start' },
            }, `载入更多（已显示 ${items.length}/${total}）`)
            : null,
        ),

        h('aside', {
          style: { width: 344, flex: 'none', overflowY: 'auto', borderLeft: border, paddingLeft: 16 },
        },
          picked
            ? h(Detail, { md5: picked, onSaved: () => load(q, limit) })
            : h('div', { style: { fontSize: 12, opacity: 0.6, padding: '12px 0' } }, '点一张图看详情'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'memebrain', order: 30, label: '表情包' }, PanelIcon),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'memebrain' }, Page),
        )
      },
    }
  },
})
