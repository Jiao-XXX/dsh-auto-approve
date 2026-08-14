import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../client.js', import.meta.url)
const PACKAGE_PATH = new URL('../package.json', import.meta.url)
const ICON_PATH = new URL('../assets/icon.svg', import.meta.url)
const ICON_ATTRIBUTE = 'data-dsh-auto-approve-icon'

class FakeElement {
  constructor(tagName, textContent = '') {
    this.nodeType = 1
    this.tagName = tagName.toUpperCase()
    this.textContent = textContent
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
  }

  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  remove() {
    const parent = this.parentElement
    if (parent === null) return
    parent.children = parent.children.filter(child => child !== this)
    this.parentElement = null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  querySelectorAll(selector) {
    if (selector !== 'button[role="menuitem"]') throw new Error(`unsupported element selector: ${selector}`)
    return descendants(this).filter(node =>
      node.tagName === 'BUTTON' && node.getAttribute('role') === 'menuitem')
  }

  querySelector(selector) {
    if (selector === '[data-composer-seat]') {
      return descendants(this).find(node => node.getAttribute('data-composer-seat') !== null) ?? null
    }
    if (selector === '[role="menu"]') {
      return descendants(this).find(node => node.getAttribute('role') === 'menu') ?? null
    }
    if (selector.includes('button[aria-label^=')) {
      return descendants(this).find(node =>
        node.tagName === 'BUTTON'
        && (node.getAttribute('aria-label')?.startsWith('访问模式，当前：') === true
          || node.getAttribute('aria-label')?.startsWith('Access mode, current: ') === true)) ?? null
    }
    throw new Error(`unsupported element selector: ${selector}`)
  }

  closest(selector) {
    if (selector !== '[data-composer-seat]') throw new Error(`unsupported closest selector: ${selector}`)
    let node = this
    while (node !== null) {
      if (node.getAttribute('data-composer-seat') !== null) return node
      node = node.parentElement
    }
    return null
  }
}

function descendants(root) {
  const result = []
  for (const child of root.children) {
    result.push(child, ...descendants(child))
  }
  return result
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html')
    this.head = this.documentElement.appendChild(new FakeElement('head'))
    this.body = this.documentElement.appendChild(new FakeElement('body'))
    this.throwOnQuery = false
  }

  createElement(tagName) {
    return new FakeElement(tagName)
  }

  querySelector(selector) {
    if (this.throwOnQuery) throw new Error('query failed')
    if (selector !== 'style[data-dsh-auto-approve-style="client"]') {
      throw new Error(`unsupported document selector: ${selector}`)
    }
    return descendants(this.documentElement).find(node =>
      node.tagName === 'STYLE' && node.getAttribute('data-dsh-auto-approve-style') === 'client') ?? null
  }

  querySelectorAll(selector) {
    if (this.throwOnQuery) throw new Error('query failed')
    const expected = [
      'button[aria-label^="访问模式，当前："]',
      'button[aria-label^="Access mode, current: "]',
    ].join(',')
    if (selector !== expected) throw new Error(`unsupported document selector: ${selector}`)
    return descendants(this.documentElement).filter(node =>
      node.tagName === 'BUTTON'
      && (node.getAttribute('aria-label')?.startsWith('访问模式，当前：') === true
        || node.getAttribute('aria-label')?.startsWith('Access mode, current: ') === true))
  }
}

function browserHarness(options = {}) {
  const document = Object.hasOwn(options, 'document') ? options.document : new FakeDocument()
  const mutationObserver = options.mutationObserver ?? true
  const animationFrame = options.animationFrame ?? true
  let registration
  const observers = []
  const frames = new Map()
  let nextFrame = 1

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.connected = false
      observers.push(this)
    }

    observe(target, options) {
      this.target = target
      this.options = options
      this.connected = true
    }

    disconnect() {
      this.connected = false
    }

    notify(records = []) {
      if (this.connected) this.callback(records)
    }
  }

  const window = {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
    ...(document === undefined ? {} : { document }),
    ...(mutationObserver ? { MutationObserver: FakeMutationObserver } : {}),
    ...(animationFrame
      ? {
          requestAnimationFrame(callback) {
            const id = nextFrame++
            frames.set(id, callback)
            return id
          },
          cancelAnimationFrame(id) { frames.delete(id) },
        }
      : {}),
  }

  vm.runInNewContext(readFileSync(CLIENT_PATH, 'utf8'), { window }, { filename: 'client.js' })
  const plugin = registration.factory()
  let dispose = () => {}
  const ctx = {
    effect(setup) {
      dispose = setup()
      return dispose
    },
  }

  return {
    ctx,
    document,
    frames,
    observers,
    plugin,
    registration,
    apply() { plugin.apply(ctx) },
    dispose() { dispose() },
    flushFrames() {
      const pending = Array.from(frames.values())
      frames.clear()
      for (const callback of pending) callback()
    },
  }
}

function permissionMenu(labels = ['Read Only', 'Workspace Write', 'Auto', 'Full access']) {
  const menu = new FakeElement('div')
  menu.setAttribute('role', 'menu')
  const items = new Map()
  for (const label of labels) {
    const item = new FakeElement('button', label)
    item.setAttribute('role', 'menuitem')
    menu.appendChild(item)
    items.set(label, item)
  }
  return { menu, items }
}

function permissionControl(document, ariaLabel, labels) {
  const wrapper = new FakeElement('span')
  const trigger = new FakeElement('button')
  trigger.setAttribute('aria-label', ariaLabel)
  trigger.appendChild(new FakeElement('span', 'Auto'))
  trigger.appendChild(new FakeElement('span'))
  const { menu, items } = permissionMenu(labels)
  wrapper.appendChild(trigger)
  wrapper.appendChild(menu)
  document.body.appendChild(wrapper)
  return { wrapper, trigger, menu, items }
}

test('package exposes the handwritten browser bundle without an install build', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
  assert.equal(manifest.exports['./client'], './client.js')
  assert.deepEqual(manifest.dsh.client, {
    platform: 'web',
    inject: [],
  })
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(manifest.files.includes('assets'))
  assert.equal(manifest.scripts.prepare, undefined)

  const app = browserHarness()
  assert.equal(app.registration.id, 'dsh-auto-approve')
  assert.equal(typeof app.plugin.apply, 'function')
  assert.deepEqual(Array.from(app.plugin.inject), [])
})

test('marks bilingual Auto triggers and only their validated permission menu rows', () => {
  const document = new FakeDocument()
  const en = permissionControl(document, 'Access mode, current: Auto')
  const zh = permissionControl(document, '访问模式，当前：Auto')
  const inactive = permissionControl(document, 'Access mode, current: Workspace Write')
  const unrelated = permissionMenu()
  document.body.appendChild(unrelated.menu)
  const beforeChildren = en.trigger.children.length
  const app = browserHarness({ document })

  app.apply()
  assert.equal(app.frames.size, 1)
  const relevant = [{ type: 'attributes', attributeName: 'aria-label', target: en.trigger }]
  app.observers[0].notify(relevant)
  app.observers[0].notify(relevant)
  assert.equal(app.frames.size, 1, 'MutationObserver callbacks are batched into one frame')
  app.flushFrames()

  assert.equal(en.trigger.getAttribute(ICON_ATTRIBUTE), 'trigger')
  assert.equal(zh.trigger.getAttribute(ICON_ATTRIBUTE), 'trigger')
  assert.equal(en.items.get('Auto').getAttribute(ICON_ATTRIBUTE), 'menu')
  assert.equal(zh.items.get('Auto').getAttribute(ICON_ATTRIBUTE), 'menu')
  assert.equal(inactive.trigger.getAttribute(ICON_ATTRIBUTE), null)
  assert.equal(inactive.items.get('Auto').getAttribute(ICON_ATTRIBUTE), 'menu')
  assert.equal(unrelated.items.get('Auto').getAttribute(ICON_ATTRIBUTE), null)
  assert.equal(en.trigger.children.length, beforeChildren, 'the enhancer does not insert icon nodes')

  const styles = descendants(document.head).filter(node => node.tagName === 'STYLE')
  assert.equal(styles.length, 1)
  assert.match(styles[0].textContent, /\[data-dsh-auto-approve-icon\]::before/)
  assert.match(styles[0].textContent, /mask:/)
  assert.match(styles[0].textContent, /data:image\/svg\+xml/)
  const maskCss = decodeURIComponent(styles[0].textContent)
  const iconPaths = Array.from(readFileSync(ICON_PATH, 'utf8').matchAll(/\bd="([^"]+)"/g), match => match[1])
  assert.equal(iconPaths.length, 2)
  for (const path of iconPaths) assert.ok(maskCss.includes(path), `CSS mask must reuse icon path ${path}`)

  app.observers[0].notify(relevant)
  app.flushFrames()
  assert.equal(descendants(document.head).filter(node => node.tagName === 'STYLE').length, 1)

  const chat = new FakeElement('div')
  const textNode = { nodeType: 3, textContent: 'streaming token' }
  app.observers[0].notify([{
    type: 'childList',
    target: chat,
    addedNodes: [textNode],
    removedNodes: [],
  }])
  assert.equal(app.frames.size, 0, 'ordinary streamed text does not schedule a document scan')
})

test('discovers an opened permission menu while Workspace Write is current', () => {
  const document = new FakeDocument()
  const wrapper = new FakeElement('span')
  const trigger = new FakeElement('button')
  trigger.setAttribute('aria-label', 'Access mode, current: Workspace Write')
  wrapper.appendChild(trigger)
  document.body.appendChild(wrapper)
  const app = browserHarness({ document })
  app.apply()
  app.flushFrames()
  assert.equal(trigger.getAttribute(ICON_ATTRIBUTE), null)

  const { menu, items } = permissionMenu()
  wrapper.appendChild(menu)
  app.observers[0].notify([{
    type: 'childList',
    target: wrapper,
    addedNodes: [menu],
    removedNodes: [],
  }])
  assert.equal(app.frames.size, 1)
  app.flushFrames()

  assert.equal(trigger.getAttribute(ICON_ATTRIBUTE), null)
  assert.equal(items.get('Auto').getAttribute(ICON_ATTRIBUTE), 'menu')
  app.dispose()
  assert.equal(items.get('Auto').getAttribute(ICON_ATTRIBUTE), null)
})

test('rejects lookalike menus and removes stale marks and owned CSS on dispose', () => {
  const document = new FakeDocument()
  const invalid = permissionControl(
    document,
    'Access mode, current: Auto',
    ['Read Only', 'Workspace Write', 'Auto'],
  )
  const app = browserHarness({ document })
  app.apply()
  app.flushFrames()

  assert.equal(invalid.trigger.getAttribute(ICON_ATTRIBUTE), 'trigger')
  assert.equal(invalid.items.get('Auto').getAttribute(ICON_ATTRIBUTE), null)

  invalid.trigger.setAttribute('aria-label', 'Access mode, current: Workspace Write')
  app.observers[0].notify([{ type: 'attributes', attributeName: 'aria-label', target: invalid.trigger }])
  app.flushFrames()
  assert.equal(invalid.trigger.getAttribute(ICON_ATTRIBUTE), null)

  invalid.trigger.setAttribute('aria-label', 'Access mode, current: Auto')
  app.observers[0].notify([{ type: 'attributes', attributeName: 'aria-label', target: invalid.trigger }])
  assert.equal(app.frames.size, 1)
  app.dispose()
  assert.equal(app.frames.size, 0)
  assert.equal(app.observers[0].connected, false)
  assert.equal(descendants(document.head).some(node => node.tagName === 'STYLE'), false)
  assert.equal(invalid.trigger.getAttribute(ICON_ATTRIBUTE), null)
})

test('missing browser APIs and selector failures are cosmetic and never fail apply', () => {
  const withoutApis = browserHarness({ document: undefined, mutationObserver: false, animationFrame: false })
  assert.doesNotThrow(() => { withoutApis.apply() })
  assert.doesNotThrow(() => { withoutApis.dispose() })

  const document = new FakeDocument()
  document.throwOnQuery = true
  const brokenQueries = browserHarness({ document })
  assert.doesNotThrow(() => { brokenQueries.apply() })
  const target = new FakeElement('button')
  target.setAttribute('aria-label', 'Access mode, current: Auto')
  assert.doesNotThrow(() => {
    brokenQueries.observers[0].notify([{ type: 'attributes', attributeName: 'aria-label', target }])
  })
  assert.doesNotThrow(() => { brokenQueries.flushFrames() })
  assert.doesNotThrow(() => { brokenQueries.dispose() })

  const brokenEffect = browserHarness()
  assert.doesNotThrow(() => {
    brokenEffect.plugin.apply({ effect() { throw new Error('effect failed') } })
  })
})
