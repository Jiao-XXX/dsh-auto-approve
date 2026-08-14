window.__ModuleLoader__.load({
  id: 'dsh-auto-approve',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const ICON_ATTRIBUTE = 'data-dsh-auto-approve-icon'
    const STYLE_ATTRIBUTE = 'data-dsh-auto-approve-style'
    const TRIGGER_LABELS = new Set([
      '访问模式，当前：Auto',
      'Access mode, current: Auto',
    ])
    const PERMISSION_LABELS = new Set([
      'Read Only',
      'Workspace Write',
      'Auto',
      'Full access',
    ])
    const TRIGGER_PREFIXES = [
      '访问模式，当前：',
      'Access mode, current: ',
    ]
    const TRIGGER_SELECTOR = [
      'button[aria-label^="访问模式，当前："]',
      'button[aria-label^="Access mode, current: "]',
    ].join(',')
    const MASK = 'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22 fill=%22none%22%3E%3Cpath d=%22M8.20554%200.899994L14.7901%203.36857V7.01026C14.7901%2012%2011.0466%2014.2103%208.20554%2015.3C5.36446%2014.2103%201.62012%2012%201.62012%207.01026V3.36857L8.20554%200.899994Z%22 stroke=%22black%22 stroke-width=%221.31831%22 stroke-linejoin=%22round%22/%3E%3Cpath d=%22M9.23047%203.44531L5.38281%208.52344H7.61719L6.86719%2012.6953L11.0078%207.16406H8.71875L9.23047%203.44531Z%22 fill=%22black%22/%3E%3C/svg%3E")'
    const CSS = `
[${ICON_ATTRIBUTE}]::before {
  content: "";
  display: inline-block;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  background-color: currentColor;
  -webkit-mask: ${MASK} center / contain no-repeat;
  mask: ${MASK} center / contain no-repeat;
}
[${ICON_ATTRIBUTE}="trigger"]::before {
  width: 14px;
  height: 14px;
}
[${ICON_ATTRIBUTE}="menu"]::before {
  color: var(--dsw-alias-label-tertiary);
}
@container (max-width: 460px) {
  [${ICON_ATTRIBUTE}="trigger"] > span:first-of-type {
    display: none;
  }
}
`

    const noop = () => {}

    function permissionTriggerLabel(value) {
      return typeof value === 'string' && TRIGGER_PREFIXES.some(prefix => value.startsWith(prefix))
    }

    function touchesPermissionSurface(node) {
      try {
        if (node?.nodeType !== 1) return false
        if (node.getAttribute?.('data-composer-seat') !== null) return true
        if (node.getAttribute?.('role') === 'menu') return true
        if (permissionTriggerLabel(node.getAttribute?.('aria-label'))) return true
        if (typeof node.querySelector === 'function') {
          if (node.querySelector('[data-composer-seat]') !== null) return true
          if (node.querySelector('[role="menu"]') !== null) return true
          if (node.querySelector(TRIGGER_SELECTOR) !== null) return true
        }
        return typeof node.closest === 'function' && node.closest('[data-composer-seat]') !== null
      } catch {
        return false
      }
    }

    function insideComposer(node) {
      try {
        if (node?.nodeType !== 1) return false
        if (node.getAttribute?.('data-composer-seat') !== null) return true
        return typeof node.closest === 'function' && node.closest('[data-composer-seat]') !== null
      } catch {
        return false
      }
    }

    function relevantMutations(records) {
      try {
        for (const record of records) {
          if (record.type === 'attributes') {
            if (record.attributeName === 'aria-label') {
              if (permissionTriggerLabel(record.target?.getAttribute?.('aria-label'))) return true
              if (record.target?.getAttribute?.(ICON_ATTRIBUTE) === 'trigger') return true
            }
            if (record.attributeName === 'role' && touchesPermissionSurface(record.target)) return true
            continue
          }
          if (record.type !== 'childList') continue
          // The target can be a rapidly updating chat node. Only inspect its
          // ancestor chain; newly attached subtrees are checked below.
          if (insideComposer(record.target)) return true
          for (const node of record.addedNodes ?? []) {
            if (touchesPermissionSurface(node)) return true
          }
          for (const node of record.removedNodes ?? []) {
            if (touchesPermissionSurface(node)) return true
          }
        }
      } catch {}
      return false
    }

    function directMenu(wrapper) {
      try {
        for (const child of wrapper?.children ?? []) {
          if (child.getAttribute?.('role') === 'menu') return child
        }
      } catch {}
      return undefined
    }

    function permissionAutoItem(menu) {
      try {
        const items = Array.from(menu.querySelectorAll('button[role="menuitem"]'))
        const byLabel = new Map()
        for (const item of items) {
          const label = item.textContent?.trim()
          if (typeof label !== 'string' || label.length === 0 || byLabel.has(label)) continue
          byLabel.set(label, item)
        }
        for (const label of PERMISSION_LABELS) {
          if (!byLabel.has(label)) return undefined
        }
        return byLabel.get('Auto')
      } catch {
        return undefined
      }
    }

    function installStyle(document) {
      try {
        const existing = document.querySelector(`style[${STYLE_ATTRIBUTE}="client"]`)
        if (existing !== null) return { node: existing, owned: false }
        const style = document.createElement('style')
        style.setAttribute(STYLE_ATTRIBUTE, 'client')
        style.textContent = CSS
        const parent = document.head ?? document.documentElement
        parent?.appendChild(style)
        return { node: style, owned: style.parentElement !== null }
      } catch {
        return { node: undefined, owned: false }
      }
    }

    function installCompatibility() {
      const document = window.document
      const Observer = window.MutationObserver
      const requestFrame = window.requestAnimationFrame
      const cancelFrame = window.cancelAnimationFrame
      if (document === undefined || typeof Observer !== 'function' || typeof requestFrame !== 'function') return noop

      let stopped = false
      let frame
      const tagged = new Set()
      const style = installStyle(document)

      const setTag = (node, value) => {
        try {
          if (node.getAttribute(ICON_ATTRIBUTE) !== value) node.setAttribute(ICON_ATTRIBUTE, value)
          tagged.add(node)
        } catch {}
      }
      const removeTag = (node) => {
        try { node.removeAttribute(ICON_ATTRIBUTE) } catch {}
        tagged.delete(node)
      }
      const reconcile = (active) => {
        for (const node of Array.from(tagged)) {
          if (!active.has(node)) removeTag(node)
        }
        for (const [node, value] of active) setTag(node, value)
      }
      const scan = () => {
        const active = new Map()
        const triggers = Array.from(document.querySelectorAll(TRIGGER_SELECTOR))
        for (const trigger of triggers) {
          const label = trigger.getAttribute?.('aria-label')
          if (!permissionTriggerLabel(label)) continue
          if (TRIGGER_LABELS.has(label)) active.set(trigger, 'trigger')
          const menu = directMenu(trigger.parentElement)
          if (menu === undefined) continue
          const autoItem = permissionAutoItem(menu)
          if (autoItem !== undefined) active.set(autoItem, 'menu')
        }
        reconcile(active)
      }
      const runScan = () => {
        frame = undefined
        if (stopped) return
        try { scan() } catch {}
      }
      const schedule = () => {
        if (stopped || frame !== undefined) return
        try { frame = requestFrame.call(window, runScan) } catch {}
      }

      let observer
      try {
        observer = new Observer((records) => {
          try {
            if (relevantMutations(records)) schedule()
          } catch {}
        })
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-label', 'role'],
        })
        schedule()
      } catch {
        try { observer?.disconnect() } catch {}
        if (style.owned) {
          try { style.node?.remove() } catch {}
        }
        return noop
      }

      return () => {
        if (stopped) return
        stopped = true
        try { observer.disconnect() } catch {}
        if (frame !== undefined && typeof cancelFrame === 'function') {
          try { cancelFrame.call(window, frame) } catch {}
        }
        frame = undefined
        for (const node of Array.from(tagged)) removeTag(node)
        if (style.owned) {
          try { style.node?.remove() } catch {}
        }
      }
    }

    function apply(ctx) {
      let cleanup = noop
      try {
        if (typeof ctx?.effect !== 'function') return
        ctx.effect(() => {
          try { cleanup = installCompatibility() } catch { cleanup = noop }
          return () => {
            try { cleanup() } catch {}
            cleanup = noop
          }
        }, 'dsh-auto-approve: permission icon compatibility')
      } catch {
        try { cleanup() } catch {}
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
