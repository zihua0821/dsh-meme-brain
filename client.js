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

      const row = (k, v) => h('div', { style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '20px' } },
        h('span', { style: { width: 64, opacity: 0.6, flex: 'none' } }, k),
        h('span', { style: { wordBreak: 'break-all' } }, v))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('img', {
          src: item.url, alt: item.name || item.md5,
          style: {
            width: '100%', maxHeight: 220, objectFit: 'contain', borderRadius: 8, border,
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
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 } },
          row('md5', h('code', { style: { fontFamily: mono } }, item.md5)),
          row('文件', `${item.ext} · ${(item.bytes / 1024).toFixed(0)}KB · ${item.width}×${item.height} · ${item.frames} 帧`),
          row('指纹', h('code', { style: { fontFamily: mono, fontSize: 11 } }, item.dhash || '—')),
          row('状态', item.state),
          row('来源', item.source || '—'),
          row('分析', item.analyzed ? '已分析' : '未分析'),
        ),
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
          style: { width: 300, flex: 'none', overflowY: 'auto', borderLeft: border, paddingLeft: 16 },
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
