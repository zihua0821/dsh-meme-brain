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

    /** 空值不进 query string：否则 character=undefined 会被当成一个筛选项 */
    function qs(params) {
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue
        p.set(k, String(v))
      }
      return p.toString()
    }

    async function get(params) {
      const res = await fetch(`${API}?${qs(params)}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error?.message || json.error?.code || '请求失败')
      return json.data
    }

    async function post(params, body) {
      const res = await fetch(`${API}?${qs(params)}`, {
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

    // 和 Host 的 src/lib/analyze.js 保持一致（改那边要同步这里）
    const SCENES = ['吃饭', '工作', '游戏', '摸鱼', '睡觉', '社交', '日常']
    const TARGETS = ['自己', '对方', '第三方', '无']

    const CONF_COLOR = {
      高: 'rgba(70,170,110,0.9)',
      中: 'rgba(210,160,60,0.9)',
      低: 'rgba(128,128,128,0.7)',
      人工: 'rgba(120,120,240,0.95)',
    }

    const stamp = (ts) => (ts ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '—')

    /** 筛选按钮：显示名字 + 张数，选中时高亮 */
    function FilterChip({ active, count, onClick, children }) {
      const dim = count === 0 && !active
      return h('button', {
        type: 'button', onClick,
        style: {
          display: 'inline-flex', alignItems: 'baseline', gap: 5, padding: '3px 10px', borderRadius: 999,
          cursor: 'pointer', font: 'inherit', fontSize: 12, lineHeight: '18px',
          border: active ? '1px solid rgba(77,107,254,0.85)' : border,
          background: active ? 'rgba(77,107,254,0.16)' : 'transparent',
          color: 'inherit', opacity: dim ? 0.45 : 1,
        },
      },
        h('span', null, children),
        h('span', { style: { fontSize: 10, opacity: 0.6, fontFamily: mono } }, String(count)),
      )
    }

    function Section({ title, children }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 } },
        h('div', {
          style: { fontSize: 10, letterSpacing: 1, opacity: 0.45, textTransform: 'uppercase', borderBottom: border, paddingBottom: 3 },
        }, title),
        children,
      )
    }

    /** 评分条：有 onChange 时可拖（详情里都传），没有就是只读 */
    function Meter({ dim, value, onChange }) {
      const has = typeof value === 'number' && Number.isFinite(value)
      const current = has ? value : dim.min
      const pct = Math.min(100, Math.max(0, ((current - dim.min) / (dim.max - dim.min)) * 100))
      const zero = dim.center ? 50 : 0
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '18px' } },
        h('span', { style: { width: 32, opacity: 0.6, flex: 'none' } }, dim.label),
        h('div', {
          style: { position: 'relative', flex: 1, height: 16, display: 'flex', alignItems: 'center' },
        },
          h('div', {
            style: { position: 'absolute', left: 0, right: 0, height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.22)', overflow: 'hidden' },
          },
            h('div', {
              style: {
                position: 'absolute', top: 0, bottom: 0, borderRadius: 3,
                left: `${Math.min(zero, pct)}%`, width: `${Math.abs(pct - zero)}%`,
                background: has ? 'rgba(77,107,254,0.85)' : 'transparent',
              },
            }),
          ),
          onChange
            ? h('input', {
              type: 'range', min: dim.min, max: dim.max, step: 0.05, value: current,
              onChange: (e) => onChange(Number(e.target.value)),
              style: { position: 'relative', width: '100%', margin: 0, background: 'transparent', accentColor: 'rgba(77,107,254,0.9)', cursor: 'pointer' },
            })
            : null,
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

    function Detail({ md5, onSaved, characters }) {
      const [item, setItem] = useState(null)
      // 所有可编辑字段放一个草稿里：改哪个保存就提交哪个（见 buildPatch）
      const [draft, setDraft] = useState(null)
      const [msg, setMsg] = useState('')

      const fromItem = (d) => ({
        name: d.name || '',
        tags: d.tags || '',
        character: d.character || '',
        appearance: d.appearance || '',
        text: d.text || '',
        scene: String(d.scene || '').split(',').map((s) => s.trim()).filter(Boolean),
        target: d.target || '无',
        score: { ...(d.score || {}) },
      })

      useEffect(() => {
        let alive = true
        setItem(null)
        setDraft(null)
        setMsg('')
        get({ op: 'item', md5 })
          .then((d) => {
            if (!alive) return
            setItem(d)
            setDraft(fromItem(d))
          })
          .catch((e) => alive && setMsg(e.message))
        return () => { alive = false }
      }, [md5])

      const setField = (key, value) => setDraft((d) => (d ? { ...d, [key]: value } : d))
      const toggleScene = (s) => setDraft((d) => {
        if (!d) return d
        const has = d.scene.includes(s)
        const next = has ? d.scene.filter((x) => x !== s) : [...d.scene, s].slice(0, 3)
        return { ...d, scene: next }
      })
      const setScore = (key, value) => setDraft((d) => (d ? { ...d, score: { ...d.score, [key]: value } } : d))

      /** 只提交真的改过的字段：否则每次点保存都会把条目锁上 */
      const buildPatch = () => {
        if (!item || !draft) return {}
        const p = {}
        if (draft.name !== (item.name || '')) p.name = draft.name
        if (draft.tags !== (item.tags || '')) p.tags = draft.tags
        if (draft.character !== (item.character || '')) p.character = draft.character
        if (draft.appearance !== (item.appearance || '')) p.appearance = draft.appearance
        if (draft.text !== (item.text || '')) p.text = draft.text

        const oldScene = String(item.scene || '').split(',').map((s) => s.trim()).filter(Boolean)
        if (draft.scene.join(',') !== oldScene.join(',')) p.scene = draft.scene.join(',')

        if ((draft.target || '无') !== (item.target || '')) p.target = draft.target

        const scorePatch = {}
        for (const dim of SCORE_DIMS) {
          const v = draft.score?.[dim.key]
          if (typeof v === 'number' && v !== item.score?.[dim.key]) scorePatch[dim.key] = v
        }
        if (Object.keys(scorePatch).length) p.score = scorePatch
        return p
      }

      const save = useCallback(async () => {
        try {
          const patch = buildPatch()
          if (!Object.keys(patch).length) {
            setMsg('没有改动')
            return
          }
          const updated = await post({ op: 'annotate' }, { md5, ...patch })
          setItem(updated)
          setDraft(fromItem(updated))
          const changed = (updated.changed || []).join('、')
          setMsg(updated.createdCharacter
            ? `已保存（${changed}），角色表新增了「${updated.character}」`
            : updated.cleared
              ? '已保存，角色已交还给模型（同时解锁）'
              : `已保存：${changed}`)
          onSaved?.()
        } catch (e) {
          setMsg(e.message)
        }
      }, [md5, draft, item, onSaved])

      const unlock = useCallback(async () => {
        try {
          const updated = await post({ op: 'annotate' }, { md5, pin: false })
          setItem(updated)
          setDraft(fromItem(updated))
          setMsg('已解除锁定，下次 analyze 会重新判断这张')
          onSaved?.()
        } catch (e) {
          setMsg(e.message)
        }
      }, [md5, onSaved])

      const [analyzing, setAnalyzing] = useState(false)

      const runAnalyze = useCallback(async () => {
        setAnalyzing(true)
        setMsg('正在叫模型看这张…')
        try {
          const data = await post({ op: 'analyze' }, { md5 })
          setItem(data.item)
          setDraft(fromItem(data.item))
          const r = data.result || {}
          if (r.skipped?.length) setMsg(`没分析：${r.skipped[0].message}`)
          else if (r.failed?.length) setMsg(`分析失败：${r.failed[0].message}`)
          else setMsg('分析完成，结果已更新')
          onSaved?.()
        } catch (e) {
          setMsg(`分析失败：${e.message}`)
        } finally {
          setAnalyzing(false)
        }
      }, [md5, onSaved])

      if (msg && !item) return h('div', { style: { padding: 12, fontSize: 12, opacity: 0.7 } }, msg)
      if (!item || !draft) return h('div', { style: { padding: 12, fontSize: 12, opacity: 0.7 } }, '载入中…')

      const row = (k, v, w = 56) => h('div', { style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '20px' } },
        h('span', { style: { width: w, opacity: 0.6, flex: 'none' } }, k),
        h('span', { style: { wordBreak: 'break-all', flex: 1, minWidth: 0 } }, v))

      const inputStyle = {
        padding: '6px 8px', borderRadius: 6, border, background: 'transparent',
        color: 'inherit', font: 'inherit', width: '100%', boxSizing: 'border-box',
      }
      const label = (text) => h('label', { style: { fontSize: 12, opacity: 0.7, display: 'block', marginTop: 4 } }, text)

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
          value: draft.name, onChange: (e) => setField('name', e.target.value),
          placeholder: '给她看的短名',
          style: inputStyle,
        }),
        h('label', { style: { fontSize: 12, opacity: 0.7 } }, '标签（逗号分隔）'),
        h('input', {
          value: draft.tags, onChange: (e) => setField('tags', e.target.value),
          placeholder: '卖萌,干饭',
          style: inputStyle,
        }),
        h('label', { style: { fontSize: 12, opacity: 0.7 } }, '角色（留空 = 未知）'),
        h('input', {
          value: draft.character, onChange: (e) => setField('character', e.target.value),
          list: 'memebrain-chars',
          placeholder: '大肥鱼 / doro / 耄耋…',
          style: inputStyle,
        }),
        h('datalist', { id: 'memebrain-chars' },
          (characters || []).map((c) => h('option', { key: c, value: c }))),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button', onClick: save,
            style: {
              padding: '6px 10px', borderRadius: 6, border, background: 'rgba(77,107,254,0.14)',
              color: 'inherit', font: 'inherit', cursor: 'pointer',
            },
          }, '保存'),
          h('button', {
            type: 'button',
            onClick: runAnalyze,
            disabled: analyzing || item.pinned,
            title: item.pinned
              ? '已人工锁定，先点「解除锁定」再分析'
              : '调用模型重新看这张图（会覆盖模型的分数、外观、图上文字）',
            style: {
              padding: '6px 10px', borderRadius: 6, border,
              background: 'transparent', color: 'inherit', font: 'inherit',
              cursor: analyzing || item.pinned ? 'not-allowed' : 'pointer',
              opacity: analyzing || item.pinned ? 0.45 : 1,
            },
          }, analyzing ? '分析中…' : item.analyzed ? '重新分析' : '分析这张'),
          item.pinned
            ? h('button', {
              type: 'button', onClick: unlock,
              style: { padding: '6px 10px', borderRadius: 6, border, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
            }, '解除锁定')
            : null,
          item.pinned
            ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, '人工锁定中：analyze 会跳过这张')
            : null,
        ),
        msg ? h('div', { style: { fontSize: 12, opacity: 0.7 } }, msg) : null,

        Section({ title: '分析结果（都能改）',
          children: [
            row('角色', h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              draft.character || h('span', { style: { opacity: 0.45 } }, '未知'),
              h('span', {
                style: {
                  fontSize: 10, lineHeight: '15px', padding: '0 5px', borderRadius: 999,
                  border: `1px solid ${CONF_COLOR[item.charConf] || 'rgba(128,128,128,0.5)'}`,
                  color: CONF_COLOR[item.charConf] || 'inherit', opacity: item.charConf ? 1 : 0.5,
                },
              }, `把握 ${item.charConf || '?'}`))),
            label('外观（看得见的特征）'),
            h('input', {
              value: draft.appearance, onChange: (e) => setField('appearance', e.target.value),
              placeholder: '蓝发双马尾、女仆装…（留空或写「无」= 清掉）',
              style: inputStyle,
            }),
            label('图上文字'),
            h('input', {
              value: draft.text, onChange: (e) => setField('text', e.target.value),
              placeholder: '图上真实出现的字（没有就留空）',
              style: inputStyle,
            }),
            label('场景（最多 3 个，点一下切换）'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
              SCENES.map((s) => h('button', {
                key: s, type: 'button', onClick: () => toggleScene(s),
                style: {
                  padding: '2px 9px', borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 12,
                  border: draft.scene.includes(s) ? '1px solid rgba(77,107,254,0.85)' : border,
                  background: draft.scene.includes(s) ? 'rgba(77,107,254,0.16)' : 'transparent',
                  color: 'inherit',
                },
              }, s))),
            label('指向'),
            h('select', {
              value: draft.target || '无', onChange: (e) => setField('target', e.target.value),
              style: inputStyle,
            }, TARGETS.map((t) => h('option', { key: t, value: t }, t))),
          ] }),

        Section({ title: '评分（拖动即可改）', children: [
          ...SCORE_DIMS.map((dim) => h(Meter, {
            key: dim.key,
            dim,
            value: draft.score?.[dim.key],
            onChange: (v) => setScore(dim.key, v),
          })),
          item.analyzed
            ? null
            : h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 4, lineHeight: '16px' } },
              '还没分析过（也可以直接拖）。要模型先看一遍：',
              h('code', { style: { fontFamily: mono } }, ` /meme analyze --md5=${item.md5.slice(0, 8)}`)),
        ] }),

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

    /** 角色表里的一行：可改名字/类型/外观/出处/别名，可改名、可删除 */
    function CharRow({ c, onChanged }) {
      const [d, setD] = useState({
        name: c.name, kind: c.kind || 'character', look: c.look || '', from: c.from || '', aka: (c.aka || []).join(', '),
      })
      const [msg, setMsg] = useState('')
      const [confirmDel, setConfirmDel] = useState(false)
      const set = (k, v) => { setD((x) => ({ ...x, [k]: v })); setMsg(''); setConfirmDel(false) }
      const dirty = d.name !== c.name || d.kind !== (c.kind || 'character') || d.look !== (c.look || '')
        || d.from !== (c.from || '') || d.aka !== (c.aka || []).join(', ')

      const save = useCallback(async () => {
        try {
          const r = await post({ op: 'char-save' }, {
            originalName: c.name, name: d.name, kind: d.kind, look: d.look, from: d.from, aka: d.aka,
          })
          setMsg(r.renamedFrom ? `已改名，库里 ${r.moved} 张跟着改并锁定` : '已保存')
          onChanged?.()
        } catch (e) {
          setMsg(e.message)
        }
      }, [c.name, d, onChanged])

      const del = useCallback(async (force) => {
        try {
          const r = await post({ op: 'char-rm' }, { name: c.name, force })
          setMsg(`已删除${r.cleared ? `（清空 ${r.cleared} 张图）` : ''}`)
          onChanged?.()
        } catch (e) {
          setMsg(e.message)
          if (/还有 \d+ 张/.test(String(e.message))) setConfirmDel(true)
        }
      }, [c.name, onChanged])

      const inp = {
        padding: '4px 6px', borderRadius: 5, border, background: 'transparent',
        color: 'inherit', font: 'inherit', fontSize: 12, boxSizing: 'border-box',
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 0', borderBottom: border } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', { value: d.name, onChange: (e) => set('name', e.target.value), style: { ...inp, width: 96, flex: 'none' } }),
          h('select', {
            value: d.kind, onChange: (e) => set('kind', e.target.value),
            style: { ...inp, width: 74, flex: 'none' },
          },
            h('option', { value: 'character' }, '角色'),
            h('option', { value: 'meme' }, '梗模板')),
          h('input', {
            value: d.look, onChange: (e) => set('look', e.target.value),
            placeholder: '外观特征（判定依据，写得排他一点）',
            style: { ...inp, flex: 1, minWidth: 0 },
          }),
          h('span', {
            style: { width: 44, flex: 'none', textAlign: 'right', fontFamily: mono, fontSize: 11, opacity: c.count ? 0.85 : 0.3 },
          }, `${c.count} 张`),
        ),
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', {
            value: d.from, onChange: (e) => set('from', e.target.value),
            placeholder: '出处', style: { ...inp, width: 140, flex: 'none' },
          }),
          h('input', {
            value: d.aka, onChange: (e) => set('aka', e.target.value),
            placeholder: '别名（逗号分隔）', style: { ...inp, flex: 1, minWidth: 0 },
          }),
          h('button', {
            type: 'button', onClick: save, disabled: !dirty,
            style: {
              padding: '3px 9px', borderRadius: 5, border, font: 'inherit', fontSize: 12,
              background: dirty ? 'rgba(77,107,254,0.16)' : 'transparent',
              opacity: dirty ? 1 : 0.4, cursor: dirty ? 'pointer' : 'default', color: 'inherit',
            },
          }, '保存'),
          confirmDel
            ? h('button', {
              type: 'button', onClick: () => del(true),
              style: { padding: '3px 9px', borderRadius: 5, border: '1px solid rgba(224,86,102,0.8)', background: 'rgba(224,86,102,0.14)', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
            }, '确认删除')
            : h('button', {
              type: 'button', onClick: () => del(false),
              style: { padding: '3px 9px', borderRadius: 5, border, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
            }, '删除'),
          msg ? h('span', { style: { fontSize: 11, opacity: 0.75, flex: 1, minWidth: 0 } }, msg) : null,
        ),
      )
    }

    /** 新建一行 */
    function NewCharRow({ onChanged }) {
      const [d, setD] = useState({ name: '', kind: 'character', look: '', from: '', aka: '' })
      const [msg, setMsg] = useState('')
      const set = (k, v) => setD((x) => ({ ...x, [k]: v }))
      const inp = {
        padding: '4px 6px', borderRadius: 5, border, background: 'transparent',
        color: 'inherit', font: 'inherit', fontSize: 12, boxSizing: 'border-box',
      }
      const create = async () => {
        if (!d.name.trim()) { setMsg('名字不能为空'); return }
        try {
          await post({ op: 'char-save' }, { name: d.name, kind: d.kind, look: d.look, from: d.from, aka: d.aka })
          setD({ name: '', kind: 'character', look: '', from: '', aka: '' })
          setMsg('已新增')
          onChanged?.()
        } catch (e) {
          setMsg(e.message)
        }
      }
      return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '7px 0', borderBottom: border } },
        h('input', { value: d.name, onChange: (e) => set('name', e.target.value), placeholder: '新角色名', style: { ...inp, width: 96, flex: 'none' } }),
        h('select', { value: d.kind, onChange: (e) => set('kind', e.target.value), style: { ...inp, width: 74, flex: 'none' } },
          h('option', { value: 'character' }, '角色'),
          h('option', { value: 'meme' }, '梗模板')),
        h('input', { value: d.look, onChange: (e) => set('look', e.target.value), placeholder: '外观特征', style: { ...inp, flex: 1, minWidth: 0 } }),
        h('input', { value: d.from, onChange: (e) => set('from', e.target.value), placeholder: '出处', style: { ...inp, width: 120, flex: 'none' } }),
        h('button', {
          type: 'button', onClick: create,
          style: { padding: '3px 9px', borderRadius: 5, border, background: 'rgba(77,107,254,0.16)', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
        }, '＋ 新增'),
        msg ? h('span', { style: { fontSize: 11, opacity: 0.75 } }, msg) : null,
      )
    }

    /**
     * 角色表弹层：可看、可改、可新增、可删除。
     * 写入全走 /meme-brain/api 的 char-save / char-rm，和命令 `/meme char add|rm` 是同一层业务。
     */
    function CharsPanel({ data, onClose, onReload, onChanged }) {
      const items = data?.items || []
      const used = items.filter((c) => c.count > 0)
      const unused = items.filter((c) => !c.count)

      return h('div', {
        style: {
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        },
        onClick: onClose,
      },
        h('div', {
          onClick: (e) => e.stopPropagation(),
          style: {
            width: 720, maxWidth: '94vw', maxHeight: '86vh', overflow: 'hidden',
            display: 'flex', flexDirection: 'column', gap: 8, padding: 16,
            borderRadius: 12, border, background: 'Canvas', color: 'CanvasText',
            boxShadow: '0 18px 50px rgba(0,0,0,0.35)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('div', { style: { fontSize: 13 } },
              `角色表 ${items.length} 条`,
              h('span', { style: { fontSize: 11, opacity: 0.6, marginLeft: 8 } },
                `库里用到的 ${used.length} 条 · 还没用到的 ${unused.length} 条`)),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button', onClick: onReload,
              style: { padding: '4px 10px', borderRadius: 6, border, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
            }, '重新读取'),
            h('button', {
              type: 'button', onClick: onClose,
              style: { padding: '4px 10px', borderRadius: 6, border, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
            }, '关闭'),
          ),

          data?.loadError
            ? h('div', { style: { fontSize: 12, color: '#e05666' } }, `角色表读取有问题：${data.loadError}`)
            : null,

          h('div', { style: { fontSize: 11, opacity: 0.55, lineHeight: '16px' } },
            '改完点「保存」。**名字一改，库里引用它的图会一起改**（并锁定，挡住 analyze --force）。',
            '删除时如果还有图在用，要再点一次「确认删除」。'),

          h('div', { style: { overflowY: 'auto', flex: 1, minHeight: 0 } },
            h('div', { style: { fontSize: 11, opacity: 0.5, margin: '4px 0 2px' } }, '库里用到的'),
            used.length ? used.map((c) => h(CharRow, { key: c.name, c, onChanged })) : h('div', { style: { fontSize: 12, opacity: 0.5 } }, '（还没有认出来的角色）'),
            h('div', { style: { fontSize: 11, opacity: 0.5, margin: '12px 0 2px' } }, '还没用到的（可当候选）'),
            unused.map((c) => h(CharRow, { key: c.name, c, onChanged })),
            h('div', { style: { fontSize: 11, opacity: 0.5, margin: '12px 0 2px' } }, '新增'),
            h(NewCharRow, { onChanged })),
        ),
      )
    }

    // 待办筛选项：key 对应 Host 的 todo 口径，name 是显示名
    const TODO_TABS = [
      { key: 'unanalyzed', label: '未分析' },
      { key: 'unnamed', label: '未命名' },
      { key: 'notags', label: '无标签' },
      { key: 'nochar', label: '未知角色' },
    ]

    function Page() {
      const [q, setQ] = useState('')
      const [draft, setDraft] = useState('')
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(0)
      const [indexed, setIndexed] = useState(true)
      const [limit, setLimit] = useState(60)
      const [picked, setPicked] = useState('')
      const [error, setError] = useState('')
      const [facets, setFacets] = useState(null)
      // 筛选状态：todo 与 character 互斥（点待办就清掉角色，反之亦然）
      const [todo, setTodo] = useState('')
      const [character, setCharacter] = useState('')
      // 角色表弹层 + 刷新计数（refreshToken 变了就让详情重新拉）
      const [chars, setChars] = useState(null)
      const [showChars, setShowChars] = useState(false)
      const [refreshToken, setRefreshToken] = useState(0)

      const load = useCallback(async (query, lim, todoKey, charKey) => {
        try {
          setError('')
          const data = await get({ op: 'list', q: query, limit: lim, todo: todoKey, character: charKey })
          setItems(data.items)
          setTotal(data.total)
          setIndexed(data.indexed)
        } catch (e) {
          setError(e.message)
        }
      }, [])

      const loadFacets = useCallback(async () => {
        try {
          setFacets(await get({ op: 'facets' }))
        } catch (e) {
          setError(e.message)
        }
      }, [])

      const loadChars = useCallback(async () => {
        try {
          setChars(await get({ op: 'chars' }))
        } catch (e) {
          setError(e.message)
        }
      }, [])

      /** 刷新：列表 + 计数 + 角色表 + 当前详情，都不动筛选条件 */
      const refreshAll = useCallback(async () => {
        await Promise.all([load(q, limit, todo, character), loadFacets(), loadChars()])
        setRefreshToken((n) => n + 1)
      }, [q, limit, todo, character, load, loadFacets, loadChars])

      useEffect(() => { load(q, limit, todo, character) }, [q, limit, todo, character, load])
      useEffect(() => { loadFacets() }, [loadFacets])

      const pickTodo = (key) => { setTodo((cur) => (cur === key ? '' : key)); setCharacter(''); setLimit(60) }
      const pickCharacter = (name) => { setCharacter((cur) => (cur === name ? '' : name)); setTodo(''); setLimit(60) }

      return h('div', {
        style: { display: 'flex', gap: 16, padding: 16, height: '100%', minHeight: 0, boxSizing: 'border-box' },
      },
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              value: draft,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { setLimit(60); setQ(draft.trim()) } },
              placeholder: '搜名字 / 标签 / 外观 / md5，回车执行',
              style: { flex: 1, padding: '7px 10px', borderRadius: 8, border, background: 'transparent', color: 'inherit', font: 'inherit' },
            }),
            h('button', {
              type: 'button',
              onClick: () => { setLimit(60); setQ(draft.trim()) },
              style: { padding: '7px 12px', borderRadius: 8, border, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
            }, '搜索'),
            h('button', {
              type: 'button',
              title: '重新拉列表 / 计数 / 角色表 / 当前详情（不动筛选）',
              onClick: () => { setLimit(60); setQ(draft.trim()); refreshAll() },
              style: { padding: '7px 12px', borderRadius: 8, border, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
            }, '刷新'),
            h('button', {
              type: 'button',
              title: '看角色表（有哪些角色、各多少张）',
              onClick: () => { setShowChars((v) => !v); if (!chars) loadChars() },
              style: {
                padding: '7px 12px', borderRadius: 8, cursor: 'pointer', font: 'inherit',
                border: showChars ? '1px solid rgba(77,107,254,0.85)' : border,
                background: showChars ? 'rgba(77,107,254,0.16)' : 'transparent',
                color: 'inherit',
              },
            }, '角色表'),
            h('span', { style: { fontSize: 12, opacity: 0.6, flex: 'none' } }, `共 ${total} 张`),
          ),

          facets
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
              h(FilterChip, {
                active: !todo && !character,
                count: facets.total,
                onClick: () => { setTodo(''); setCharacter(''); setLimit(60) },
              }, '全部'),
              h('span', { style: { width: 1, height: 16, background: 'rgba(128,128,128,0.3)', margin: '0 4px' } }),
              TODO_TABS.map((t) => h(FilterChip, {
                key: t.key,
                active: todo === t.key,
                count: facets.todo?.[t.key] ?? 0,
                onClick: () => pickTodo(t.key),
              }, t.label)),
              h('span', { style: { width: 1, height: 16, background: 'rgba(128,128,128,0.3)', margin: '0 4px' } }),
              facets.characters.map((c) => h(FilterChip, {
                key: c.name,
                active: character === c.name,
                count: c.count,
                onClick: () => pickCharacter(c.name),
              }, c.name)),
              facets.pinned
                ? h('span', { style: { fontSize: 11, opacity: 0.55, marginLeft: 6 } }, `人工锁定 ${facets.pinned}`)
                : null,
            )
            : null,

          !indexed
            ? h('div', { style: { fontSize: 13, opacity: 0.7, padding: 12 } }, '还没有索引：先运行 /meme import')
            : null,
          error ? h('div', { style: { fontSize: 12, color: '#e05666' } }, error) : null,

          items.length === 0 && !error && indexed
            ? h('div', { style: { fontSize: 13, opacity: 0.6, padding: '12px 0' } },
              todo || character ? '这个筛选下没有图了 —— 说明这一类已经清空。' : '库里还没有图。')
            : null,

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
            ? h(Detail, {
              // refreshToken 变了就连同 key 一起变，详情重新拉一次
              key: `${picked}:${refreshToken}`,
              md5: picked,
              characters: (facets?.characters || []).map((c) => c.name),
              onSaved: () => { load(q, limit, todo, character); loadFacets() },
            })
            : h('div', { style: { fontSize: 12, opacity: 0.6, padding: '12px 0' } }, '点一张图看详情'),
        ),

        showChars ? h(CharsPanel, {
          data: chars,
          onClose: () => setShowChars(false),
          onReload: loadChars,
          onChanged: () => { loadChars(); loadFacets(); load(q, limit, todo, character) },
        }) : null,
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
