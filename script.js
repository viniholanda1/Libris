/* Updated script.js — DOM blindagem e limpeza imediata de subscriptions ao signOut.
   Preserva obrigatoriedade schoolId, validações de estoque e regras de autenticação. */

import { auth, signInWithEmailAndPassword, signOut } from './firebase.js'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { open } from '@tauri-apps/plugin-shell'
import { createLocalStore } from './local-store.mjs'
import { createLocalDataApi } from './local-data.mjs'
import { isCompleteBookScan, parseBookScan } from './book-scan.mjs'
import { isValidIsbn, normalizeIsbn } from './isbn.mjs'
import { isStudentReader, isTeacherReader, studentCourseLoans } from './reader-profiles.mjs'
import { extendLoanDueDate, getLoanDueDate, getLoanQuantity, getLoanQuantityLimit } from './loan-rules.mjs'
import { createCoordinationEmailHtml, createStudentEmailHtml } from './email-templates.mjs'
import { backupCollectionFiles, optionalBackupCollectionFiles, backupRecordFromRow, parseBackupCell, resolveLegacyCategory } from './csv-backup.mjs'
import * as XLSX from 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm'

const localStore = createLocalStore()
const localData = createLocalDataApi(localStore)
const { db, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, onSnapshot, runTransaction, writeBatch, serverTimestamp, Timestamp, increment } = localData
const config = {
  organizationName: 'Libris',
  currentSchoolId: 'escola-padrao',
  schoolName: 'Biblioteca escolar',
  coordinationEmail: '',
  reminderDays: 1,
  coordinationDays: 7,
  maxBooksStudent: 2,
  maxBooksTeacher: 35,
  studentLoanDays: 7,
  teacherLoanDays: 21,
  smtp: { host: '', port: 587, username: '' }
}

function getMaxLoanDaysForReader(reader) {
  if (isTeacherReader(reader)) return Math.min(180, Math.max(1, Math.trunc(Number(config.teacherLoanDays) || 21)))
  if (isStudentReader(reader)) return Math.min(180, Math.max(1, Math.trunc(Number(config.studentLoanDays) || 7)))
  return null
}

function updateLoanDaysLimit(reader, resetToMaximum = false) {
  const input = $('#loanDays')
  if (!input) return
  const maximum = getMaxLoanDaysForReader(reader)
  const help = $('#loanDaysHelp')
  if (maximum === null) {
    input.removeAttribute('max')
    if (help) {
      help.textContent = ''
      help.hidden = true
    }
    if (resetToMaximum) input.value = String(config.studentLoanDays || 7)
    return
  }

  input.max = String(maximum)
  const currentDays = Number(input.value)
  if (resetToMaximum || !Number.isInteger(currentDays) || currentDays < 1 || currentDays > maximum) input.value = String(maximum)
  if (help) {
    const profile = isTeacherReader(reader) ? 'professor' : 'aluno'
    help.textContent = `Prazo máximo para ${profile}: ${maximum} dias. Informe um valor entre 1 e ${maximum}.`
    help.hidden = false
  }
}

const defaultCategories = []
const categories = [{ id: 'all', name: 'Todas' }, ...defaultCategories]
const LOCAL_SESSION_KEY = 'libris-local-session'

const state = {
  user: null,
  profile: null,
  books: [],
  readers: [],
  loans: [],
  csv: [],
  categories: [...defaultCategories],
  acervoQuery: '',
  readerQuery: '',
  readerFilter: 'all',
  loanQuery: '',
  adminUnsubs: [],
  loanFilter: 'all'
}

let pendingCsvImport = null
const selectedLabelQuantities = new Map()
let schoolSetupRequired = false

/* -------------------------
   DOM helpers & utilities (blindados)
   ------------------------- */
const $ = (s) => (typeof document !== 'undefined' ? document?.querySelector?.(s) ?? null : null)
const $$ = (s) => (typeof document !== 'undefined' ? Array.from(document?.querySelectorAll?.(s) || []) : [])
const esc = (v = '') => String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c])
const getCategoryOptions = () => (state.categories.length ? state.categories : defaultCategories)
const label = (id) => getCategoryOptions().find((x) => x.id === id)?.name || categories.find((x) => x.id === id)?.name || 'Geral'
function getThemePreference() {
  try {
    const preference = localStorage.getItem('libris-theme')
    return ['light', 'dark'].includes(preference) ? preference : 'system'
  } catch (err) {
    console.warn('Não foi possível ler a preferência de aparência.', err)
    return 'system'
  }
}

function applyThemePreference(preference, persist = false) {
  if (!['system', 'light', 'dark'].includes(preference)) {
    throw new Error(`Preferência de aparência inválida: ${preference}`)
  }
  if (preference === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.dataset.theme = preference

  if (persist) {
    try {
      if (preference === 'system') localStorage.removeItem('libris-theme')
      else localStorage.setItem('libris-theme', preference)
      toast('Aparência atualizada neste dispositivo.')
    } catch (err) {
      console.error('Não foi possível salvar a preferência de aparência.', err)
      toast('A aparência mudou, mas não foi possível salvar a preferência neste dispositivo.', 'error')
    }
  }
}

function bookCategoryName(book = {}) {
  const options = getCategoryOptions()
  const prefix = String(book.code || '').match(/^([A-Z0-9]{1,4})-\d{4}$/i)?.[1]
  const candidates = [book.categoryId, book.categoryName, prefix]
    .filter(Boolean)
    .map((value) => String(value).trim().toLocaleLowerCase('pt-BR'))

  for (const candidate of candidates) {
    const category = options.find((item) => [item.id, item.docId, item.code, item.name]
      .some((value) => String(value || '').trim().toLocaleLowerCase('pt-BR') === candidate))
    if (category?.name) return category.name
  }
  return String(book.categoryName || book.categoryId || prefix || 'Geral')
}
const available = (b) => Number(b.available || 0) > 0
const bookStatus = (b) => available(b) ? 'disponivel' : 'emprestado'
const date = (v) => v?.toDate ? v.toDate() : v ? new Date(v) : null
const formatDate = (v) => date(v)?.toLocaleDateString('pt-BR') || '—'
function dateTimeLocalValue(value) {
  const parsed = date(value)
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) return ''
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
const overdue = (l) => {
  const dueDate = date(getLoanDueDate(l))
  return l.status === 'active' && dueDate instanceof Date && !Number.isNaN(dueDate.getTime()) && dueDate < new Date()
}

function toast(message, type = 'success') { const el = $('#toast'); if (!el) return; el.textContent = message; el.className = `toast ${type}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.className = 'toast hidden' }, 4000) }
function error(err, message = 'Não foi possível conectar ao servidor. Verifique sua conexão.') { console.error(err); toast(err?.code === 'auth/invalid-credential' ? 'E-mail ou senha inválidos.' : message, 'error') }
function loading(button, value, text = 'Aguarde…') { if (!button) return; button.disabled = value; if (value) { button.dataset.text = button.textContent; button.textContent = text } else button.textContent = button.dataset.text || button.textContent }

/* Modal helper with accessibility blur on close */
function modal(id, open) { 
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null
  if (el) { 
    if (!open) {
      const activeElement = el.querySelector(':focus')
      if (activeElement) activeElement.blur()
    }
    el.classList.toggle('hidden', !open)
    el.setAttribute('aria-hidden', String(!open))
  }
}

/* -------------------------
   Metadata lookup (admin)
   ------------------------- */
async function lookupBookMetadata(title, author, publisher) {
  const query = [title, author, publisher].filter(Boolean).join(' ')
  if (!query) return { synopsis: '', coverUrl: '' }

  try {
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1&langRestrict=pt`)
    if (response.ok) {
      const volume = (await response.json()).items?.[0]?.volumeInfo
      if (volume) {
        const coverUrl = volume.imageLinks?.thumbnail?.replace('http://', 'https://') || volume.imageLinks?.smallThumbnail?.replace('http://', 'https://') || ''
        const synopsis = String(volume.description || '').replace(/<[^>]*>/g, '').trim().slice(0, 700)
        if (coverUrl || synopsis) return { synopsis, coverUrl }
      }
    }
  } catch (error) {
    console.warn('Não foi possível buscar dados no Google Books:', error)
  }

  try {
    const response = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}&publisher=${encodeURIComponent(publisher || '')}&limit=1`)
    if (!response.ok) return { synopsis: '', coverUrl: '' }
    const doc = (await response.json()).docs?.[0]
    if (!doc) return { synopsis: '', coverUrl: '' }
    const synopsis = Array.isArray(doc.first_sentence) ? doc.first_sentence.join(' ') : String(doc.first_sentence || '')
    const coverId = doc.cover_i || doc.covers?.[0]
    return { synopsis: synopsis.slice(0, 700), coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : '' }
  } catch (error) {
    console.warn('Não foi possível buscar dados na Open Library:', error)
    return { synopsis: '', coverUrl: '' }
  }
}

/* -------------------------
   UI renderers (admin)
   ------------------------- */
function renderCategorySelect() {
  const select = $('#bookCategoryInput')
  if (!select) return
  const categoriesList = state?.categories || []
  select.innerHTML = categoriesList.map((c) => {
    const codeVal = String(c.code || c.id || '').toUpperCase()
    return `<option value="${codeVal}">${esc(c.name)}</option>`
  }).join('')
}

function renderCategoryList() {
  const list = $('#categoryList')
  if (!list) return
  list.innerHTML = getCategoryOptions().length ? getCategoryOptions().map((c) => `<div class="category-item"><span>${esc(c.name)}</span><small>${esc(c.code || c.id)}</small><button type="button" class="small-btn danger" data-del-category="${esc(c.docId || c.id)}">Apagar</button></div>`).join('') : '<p class="empty-state">Nenhuma categoria cadastrada.</p>'
  $$('[data-del-category]').forEach((b) => b.onclick = () => removeCategory(b.dataset.delCategory))
}

function renderBooks() {
  const body = $('#bookTableBody')
  if (!body) return
  const q = state.acervoQuery.toLowerCase().trim()
  const list = state.books.filter((book) => !q || [
    book.title,
    book.author,
    book.code,
    book.isbn,
    book.legacyCatalogReference || book.tombamento
  ].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(q)))
  body.innerHTML = list.length ? list.map((book) => {
    const status = bookStatus(book)
    return `<tr>
      <td>${esc(book.code)}</td>
      <td>${esc(book.title)}</td>
      <td>${esc(bookCategoryName(book))}</td>
      <td>${esc(book.legacyCatalogReference || book.tombamento || '—')}</td>
      <td>${esc(book.isbn || 'Não informado')}</td>
      <td>${Number(book.total || 0)}</td>
      <td>${esc(book.shelf || '—')}</td>
      <td><span class="badge ${status === 'disponivel' ? 'available' : 'borrowed'}">${status === 'disponivel' ? 'Disponível' : 'Emprestado'}</span></td>
      <td><div class="action-row"><button class="small-btn primary" type="button" data-edit-book="${esc(book.id)}">Editar</button><button class="small-btn danger" type="button" data-del-book="${esc(book.id)}">Apagar</button></div></td>
    </tr>`
  }).join('') : '<tr><td colspan="9">Nenhum livro cadastrado.</td></tr>'
  $$('[data-edit-book]').forEach((button) => button.onclick = () => editBook(button.dataset.editBook))
  $$('[data-del-book]').forEach((b) => b.onclick = () => removeBook(b.dataset.delBook))
}

function renderReaderSelector() {
  const input = $('#readerInput')
  const suggestions = $('#readerSuggestions')
  if (!input || !suggestions) return

  const queryText = input.value.trim().toLocaleLowerCase('pt-BR')
  if (!queryText || $('#loanReaderIdInput')?.value) {
    suggestions.replaceChildren()
    suggestions.hidden = true
    input.setAttribute('aria-expanded', 'false')
    return
  }

  const matches = state.readers.filter((reader) => [
    reader.name,
    reader.matricula,
    reader.email,
    reader.phone,
    reader.course,
    reader.class,
    reader.type
  ].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText))).slice(0, 8)

  suggestions.innerHTML = matches.length ? matches.map((reader) => `
    <button class="reader-suggestion" type="button" role="option" data-select-loan-reader="${esc(reader.id)}">
      <span class="reader-suggestion-main">${esc(reader.name || 'Leitor sem nome')}</span>
      <span class="reader-suggestion-meta">${esc(reader.matricula || reader.type || reader.role || 'Leitor')} · ${esc(reader.course || reader.class || reader.email || '')}</span>
    </button>
  `).join('') : '<p class="reader-suggestions-empty">Nenhum leitor encontrado nesta escola.</p>'
  suggestions.hidden = false
  input.setAttribute('aria-expanded', 'true')
}

function selectLoanReader(readerId) {
  const reader = state.readers.find((item) => item.id === readerId)
  const input = $('#readerInput')
  const selectedId = $('#loanReaderIdInput')
  const suggestions = $('#readerSuggestions')
  if (!reader || !input || !selectedId) return

  input.value = `${reader.name || ''}${reader.matricula ? ` · ${reader.matricula}` : ''}`
  selectedId.value = reader.id
  updateLoanDaysLimit(reader)
  updateLoanQuantityLimit(reader)
  if (suggestions) {
    suggestions.replaceChildren()
    suggestions.hidden = true
  }
  input.setAttribute('aria-expanded', 'false')
}

function renderReaders() { 
  const body = $('#readersTableBody')
  if (!body) return;
  const q = state.readerQuery.toLowerCase().trim()
  const list = state.readers.filter((reader) => {
    const student = isStudentReader(reader)
    const teacher = isTeacherReader(reader)
    const matchesFilter = state.readerFilter === 'students'
      ? student
      : state.readerFilter === 'teachers'
        ? teacher
        : state.readerFilter === 'others'
          ? !student && !teacher
          : true
    return matchesFilter && (!q || [reader.name, reader.type, reader.role, reader.matricula].some((x) => String(x || '').toLowerCase().includes(q)))
  })
  body.innerHTML = list.length ? list.map((r) => {
    const course = isStudentReader(r) ? r.course || r.class || '—' : 'Outros'
    return `<tr><td>${esc(r.name)}</td><td>${esc(r.type || r.role || 'Aluno')}</td><td>${esc(course)}</td><td>${esc(isStudentReader(r) ? r.matricula || 'Não informado' : r.cpf || 'Não informado')}</td><td>${esc(r.email || '—')}<br><small>${esc(r.phone || '')}</small></td><td><div class="action-row"><button class="small-btn primary" type="button" data-edit-reader="${esc(r.id)}">Editar</button><button class="small-btn danger" type="button" data-del-reader="${esc(r.id)}">Apagar</button></div></td></tr>`
  }).join('') : '<tr><td colspan="6">Nenhum leitor cadastrado.</td></tr>'
  $$('[data-edit-reader]').forEach((b) => b.onclick = () => editReader(b.dataset.editReader)); 
  $$('[data-del-reader]').forEach((b) => b.onclick = () => removeReader(b.dataset.delReader)); 
  renderReaderSelector()
}

function count(list, key) { const map = new Map(); list.forEach((x) => { const k = key(x); map.set(k, (map.get(k) || 0) + 1) }); return [...map].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) }

function loanQuantity(loan) {
  return getLoanQuantity(loan)
}

function countLoanCopies(loans, key) {
  const map = new Map()
  loans.forEach((loan) => {
    const label = key(loan)
    map.set(label, (map.get(label) || 0) + loanQuantity(loan))
  })
  return [...map].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
}

function updateLoanQuantityLimit(reader = null) {
  const field = $('#loanQuantityField')
  const input = $('#loanQuantityInput')
  const help = $('#loanQuantityHelp')
  if (!field || !input) return

  field.hidden = false
  const bookCode = $('#bookCodeInput')?.value.trim().toUpperCase()
  const book = state.books.find((item) => item.code?.toUpperCase() === bookCode)
  const availableCopies = book ? Number(book.available ?? 0) : null
  if (!reader) {
    if (availableCopies === null) input.removeAttribute('max')
    else input.max = String(availableCopies)
    input.disabled = availableCopies === 0
    if (availableCopies !== null) {
      input.value = String(Math.max(1, Math.min(Number(input.value) || 1, availableCopies || 1)))
    }
    if (help) {
      help.textContent = book
        ? availableCopies > 0
          ? `Disponíveis deste título: ${availableCopies}. Selecione o leitor para conferir o limite.`
          : 'Este livro não tem exemplares disponíveis no momento.'
        : 'Informe o livro e selecione o leitor para calcular a quantidade permitida.'
      help.hidden = false
    }
    return
  }

  const loanLimit = getLoanLimitForReader(reader)
  const quantityLimit = getLoanQuantityLimit({
    loanLimit,
    activeLoans: state.loans,
    readerId: reader.id,
    availableCopies: availableCopies ?? Number.MAX_SAFE_INTEGER
  })
  const { activeCopies, remainingReaderCopies, maximum } = quantityLimit
  input.max = String(maximum)
  input.disabled = maximum < 1
  input.value = String(Math.max(1, Math.min(Number(input.value) || 1, maximum || 1)))
  if (help) {
    help.textContent = maximum < 1
      ? book && Number(book.available || 0) < 1
        ? 'Este livro não tem exemplares disponíveis no momento.'
        : 'O leitor já atingiu o limite de empréstimos configurado.'
      : book
        ? `Disponíveis deste título: ${availableCopies}. Limite do leitor: ${loanLimit}; já possui ${activeCopies} e pode emprestar mais ${remainingReaderCopies}. Máximo neste empréstimo: ${maximum}.`
        : `Limite do leitor: ${loanLimit}; já possui ${activeCopies} e pode emprestar mais ${remainingReaderCopies}. Informe o livro para conferir o estoque.`
    help.hidden = false
  }
}

function renderBars(target, data) { if (!target) return; if (!data.length) { target.innerHTML = '<p class="empty-state">Sem dados.</p>'; return }; const max = Math.max(...data.map((x) => x.value), 1); target.innerHTML = data.map((x) => `<div class="bar-row"><span>${esc(x.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${x.value / max * 100}%"></div></div><strong>${x.value}</strong></div>`).join('') }

function monthlyBookRegistrationData(books, referenceDate = new Date(), monthCount = 6) {
  const months = Array.from({ length: monthCount }, (_, index) => {
    const monthDate = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - monthCount + 1 + index, 1)
    return {
      key: `${monthDate.getFullYear()}-${monthDate.getMonth()}`,
      label: monthDate.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''),
      value: 0
    }
  })
  const monthByKey = new Map(months.map((month) => [month.key, month]))

  books.forEach((book) => {
    const createdAt = date(book.createdAt)
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return
    const month = monthByKey.get(`${createdAt.getFullYear()}-${createdAt.getMonth()}`)
    const quantity = Number(book.total || 0)
    if (month && Number.isFinite(quantity) && quantity > 0) month.value += quantity
  })

  return months
}

function renderDashboard() {
  const active = state.loans.filter((l) => l.status === 'active')
  const activeCount = active.reduce((total, loan) => total + loanQuantity(loan), 0)
  const overdueCount = active.filter(overdue).reduce((total, loan) => total + loanQuantity(loan), 0)

  const values = [
    ['Total de Livros', state.books.reduce((n, b) => n + Number(b.total || 0), 0), '📚', 'acervo', ''],
    ['Exemplares Emprestados', activeCount, '📖', 'checkout', 'all'],
    ['Exemplares em Atraso', overdueCount, '⚠️', 'checkout', 'overdue'],
    ['Leitores Cadastrados', state.readers.length, '👥', 'leitores', '']
  ]

  const kpiGrid = $('#kpiGrid')
  if (kpiGrid) {
    kpiGrid.innerHTML = values.map(([name, value, icon, targetTab, targetFilter]) => `
      <div
        class="kpi-card panel clickable-kpi"
        data-target-tab="${targetTab}"
        data-target-filter="${targetFilter}"
        style="cursor: pointer;"
      >
        <div class="kpi-card-head">
          <span>${esc(name)}</span>
          <span class="kpi-icon">${icon}</span>
        </div>
        <div class="kpi-value">${value}</div>
      </div>
    `).join('')

    $$('.clickable-kpi').forEach((card) => {
      card.onclick = () => {
        const targetTab = card.dataset.targetTab
        if (!targetTab) return

        setAdminTab(targetTab)

        if (targetTab === 'checkout') {
          const filterSelect = $('#loanFilterSelect')
          const targetFilter = card.dataset.targetFilter || 'all'

          if (filterSelect) {
            filterSelect.value = targetFilter
            filterSelect.dispatchEvent(new Event('change', { bubbles: true }))
          } else {
            state.loanFilter = targetFilter
            renderLoans()
          }
        }

        $('.admin-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
  }

  const categoryNames = new Map()

  getCategoryOptions().forEach((category) => {
    const name = String(category.name || category.code || category.id || '').trim()
    if (!name) return

    for (const key of [category.id, category.code, category.name]) {
      if (key) categoryNames.set(String(key).trim().toLocaleLowerCase('pt-BR'), name)
    }
  })

  const booksByGenre = new Map()

  state.books.forEach((book) => {
    const categoryKey = String(book.categoryId || '').trim().toLocaleLowerCase('pt-BR')
    const categoryName = String(book.categoryName || '').trim()
    const codePrefix = String(book.code || '').match(/^([A-Z0-9]{1,4})-\d{4}$/i)?.[1]
    const genre =
      categoryNames.get(categoryKey) ||
      (categoryName && categoryName !== categoryKey ? categoryName : '') ||
      categoryNames.get(String(codePrefix || '').toLocaleLowerCase('pt-BR')) ||
      categoryName ||
      codePrefix ||
      'Sem categoria'

    booksByGenre.set(genre, (booksByGenre.get(genre) || 0) + 1)
  })

  const topGenres = [...booksByGenre]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'pt-BR'))
    .slice(0, 5)

  renderBars($('#genreChart'), topGenres)
  const total = state.books.reduce((n, b) => n + Number(b.total || 0), 0)
  const free = state.books.reduce((n, b) => n + Number(b.available || 0), 0)
  const percent = total ? Math.round(free / total * 100) : 0
  if ($('#statusDonut')) $('#statusDonut').innerHTML = `<div class="donut" style="background:conic-gradient(var(--success) 0 ${percent}%,var(--warning) ${percent}% 100%)"><div class="donut-center">${percent}%</div></div>`
  if ($('#statusLegend')) $('#statusLegend').innerHTML = `<div class="legend-item"><span class="legend-dot success"></span>Disponíveis: ${free}</div><div class="legend-item"><span class="legend-dot warning"></span>Emprestados: ${Math.max(0, total - free)}</div>`
  const activeStudentCourseLoans = studentCourseLoans(active, state.readers)
  renderBars($('#courseChart'), countLoanCopies(activeStudentCourseLoans, (loan) => loan.readerCourse).slice(0, 5))
  const top = countLoanCopies(state.loans, (l) => l.readerName || 'Leitor').slice(0, 5)
  if ($('#readerChart')) $('#readerChart').innerHTML = top.length ? top.map((x) => `<div class="list-item"><strong>${esc(x.label)}</strong><span>${x.value} exemplares</span></div>`).join('') : '<p class="empty-state">Sem dados.</p>'

  const currentYear = new Date().getFullYear()
  const monthCounts = Array.from({ length: 12 }, (_, index) => {
    const monthDate = new Date(currentYear, index, 1)
    return {
      key: `${monthDate.getFullYear()}-${monthDate.getMonth()}`,
      label: monthDate.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''),
      value: 0
    }
  })
  const monthCountByKey = new Map(monthCounts.map((month) => [month.key, month]))
  state.loans.forEach((loan) => {
    const createdAt = date(loan.createdAt)
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return
    const month = monthCountByKey.get(`${createdAt.getFullYear()}-${createdAt.getMonth()}`)
    if (month)     month.value += loanQuantity(loan)
  })
  renderBars($('#monthlyLoanChart'), monthCounts.some((month) => month.value > 0) ? monthCounts : [])
  const monthlyBookCounts = monthlyBookRegistrationData(state.books)
  renderBars($('#monthlyChart'), monthlyBookCounts.some((month) => month.value > 0) ? monthlyBookCounts : [])

  const readerTypeCounts = new Map([
    ['Alunos', 0],
    ['Professores', 0],
    ['Outros', 0]
  ])
  state.readers.forEach((reader) => {
    const type = String(reader.type || reader.role || '').toLocaleLowerCase('pt-BR')
    const label = isStudentReader(reader)
      ? 'Alunos'
      : type === 'professor' || type === 'teacher'
        ? 'Professores'
        : 'Outros'
    readerTypeCounts.set(label, readerTypeCounts.get(label) + 1)
  })
  const readerTypeSegments = [...readerTypeCounts].map(([label, value], index) => ({
    label,
    value,
    color: ['var(--success)', 'var(--warning)', 'var(--primary)'][index]
  }))
  const readerTypeTotal = readerTypeSegments.reduce((sum, segment) => sum + segment.value, 0)
  let readerTypeDegrees = 0
  const readerTypeGradient = readerTypeTotal
    ? readerTypeSegments.map((segment, index) => {
      const start = readerTypeDegrees
      readerTypeDegrees += index === readerTypeSegments.length - 1
        ? 360 - readerTypeDegrees
        : segment.value / readerTypeTotal * 360
      return `${segment.color} ${start}deg ${readerTypeDegrees}deg`
    }).join(',')
    : 'var(--panel-muted) 0deg 360deg'
  if ($('#readerTypeDonut')) {
    $('#readerTypeDonut').innerHTML = `<div class="donut" style="background:conic-gradient(${readerTypeGradient})"><div class="donut-center">${readerTypeTotal}</div></div>`
  }
  if ($('#readerTypeLegend')) {
    $('#readerTypeLegend').innerHTML = readerTypeSegments.map((segment, index) => `<div class="legend-item"><span class="legend-dot ${['success', 'warning', 'reader-other'][index]}"></span>${segment.label}: ${segment.value}</div>`).join('')
  }

  renderBars(
    $('#topBooksChart'),
    countLoanCopies(state.loans, (loan) => loan.bookTitle || loan.bookCode || 'Livro sem título').slice(0, 5)
  )

  const readersById = new Map(state.readers.map((reader) => [reader.id, reader]))
  const activeLoansByReaderType = count(active, (loan) => {
    const reader = readersById.get(loan.readerId)
    return reader && isStudentReader(reader) ? 'Alunos' : 'Professores e outros'
  })
  renderBars($('#loansByReaderTypeChart'), activeLoansByReaderType)
}

function dashboardExportPeriod() {
  const selected = $('#dashboardExportPeriod')?.value || '30'
  const now = new Date()
  const start = selected === 'all'
    ? new Date(0)
    : new Date(now.getTime() - Number(selected) * 86400000)
  const loans = state.loans.filter((loan) => {
    if (selected === 'all') return true
    const createdAt = date(loan.createdAt)
    return createdAt instanceof Date && !Number.isNaN(createdAt.getTime()) && createdAt >= start && createdAt <= now
  })
  const returns = state.loans.filter((loan) => {
    const returnedAt = date(loan.returnedAt)
    return returnedAt instanceof Date && !Number.isNaN(returnedAt.getTime()) &&
      (selected === 'all' || (returnedAt >= start && returnedAt <= now))
  })
  return {
    now,
    start,
    period: selected,
    loans,
    returns,
    label: selected === 'all'
      ? 'Todo o período'
      : `${start.toLocaleDateString('pt-BR')} a ${now.toLocaleDateString('pt-BR')}`
  }
}

function dashboardExportData() {
  const period = dashboardExportPeriod()
  const readerById = new Map(state.readers.map((reader) => [reader.id, reader]))
  const groupLoans = (keyForLoan) => countLoanCopies(period.loans, keyForLoan).slice(0, 5)
  const loanReaderType = (loan) => {
    const reader = readerById.get(loan.readerId)
    if (isStudentReader(reader)) return 'Alunos'
    if (isTeacherReader(reader)) return 'Professores'
    return 'Outros'
  }
  const genreData = count(state.books, (book) => bookCategoryName(book)).slice(0, 5)
  const monthlyBuckets = Array.from({ length: 6 }, (_, index) => {
    const start = new Date(period.now.getFullYear(), period.now.getMonth() - 5 + index, 1)
    return {
      label: start.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''),
      value: 0
    }
  })
  const monthlyByKey = new Map(monthlyBuckets.map((bucket, index) => {
    const start = new Date(period.now.getFullYear(), period.now.getMonth() - 5 + index, 1)
    return [`${start.getFullYear()}-${start.getMonth()}`, bucket]
  }))
  period.loans.forEach((loan) => {
    const createdAt = date(loan.createdAt)
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return
    const bucket = monthlyByKey.get(`${createdAt.getFullYear()}-${createdAt.getMonth()}`)
    if (bucket) bucket.value += loanQuantity(loan)
  })
  const monthlyBookBuckets = monthlyBookRegistrationData(state.books, period.now)
  return {
    ...period,
    readerById,
    charts: [
      { title: 'Top 5 Gêneros', kind: 'bars', data: genreData },
      { title: 'Status do Acervo', kind: 'donut', data: [
        { label: 'Disponíveis', value: state.books.reduce((sum, book) => sum + Number(book.available || 0), 0) },
        { label: 'Emprestados', value: Math.max(0, state.books.reduce((sum, book) => sum + Number(book.total || 0), 0) - state.books.reduce((sum, book) => sum + Number(book.available || 0), 0)) }
      ] },
      { title: 'Empréstimos por Curso/Turma', kind: 'bars', data: groupLoans((loan) => loan.readerCourse || 'Não informado') },
      { title: 'Top Leitores', kind: 'bars', data: groupLoans((loan) => loan.readerName || 'Leitor') },
      { title: 'Empréstimos por mês', kind: 'bars', data: monthlyBuckets.filter((bucket) => bucket.value > 0) },
      { title: 'Evolução Mensal do Acervo', kind: 'bars', data: monthlyBookBuckets.filter((bucket) => bucket.value > 0) },
      { title: 'Perfil dos leitores', kind: 'donut', data: [
        { label: 'Alunos', value: state.readers.filter(isStudentReader).length },
        { label: 'Professores', value: state.readers.filter(isTeacherReader).length },
        { label: 'Outros', value: state.readers.filter((reader) => !isStudentReader(reader) && !isTeacherReader(reader)).length }
      ] },
      { title: 'Livros mais emprestados', kind: 'bars', data: groupLoans((loan) => loan.bookTitle || loan.bookCode || 'Livro sem título') },
      { title: 'Exemplares emprestados por perfil', kind: 'bars', data: groupLoans(loanReaderType) }
    ]
  }
}

function createDashboardExportCanvas(data) {
  const canvas = document.createElement('canvas')
  canvas.width = 1600
  const columns = 2
  const margin = 64
  const gapX = 28
  const gapY = 24
  const top = 158
  const rows = Math.ceil(data.charts.length / columns)
  const cardHeight = (2263 - top - margin - gapY * 3) / 4
  canvas.height = Math.ceil(top + margin + cardHeight * rows + gapY * Math.max(0, rows - 1))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Não foi possível preparar a imagem dos gráficos.')
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const palette = dark
    ? { page: '#10161e', panel: '#18212b', text: '#eef3f8', muted: '#b3bfca', line: '#364453', track: '#303d4c', colors: ['#4778f5', '#4fdb93', '#ffca6e', '#c09aff', '#ff8389'] }
    : { page: '#f3f7f4', panel: '#ffffff', text: '#17251c', muted: '#4d5d52', line: '#c7d8cc', track: '#e8efea', colors: ['#2457d6', '#087a49', '#e99424', '#8b4bd8', '#c33d4b'] }
  context.fillStyle = palette.page
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = palette.text
  context.font = '700 42px Arial'
  context.fillText('Libris — Gráficos gerais', 64, 76)
  context.fillStyle = palette.muted
  context.font = '24px Arial'
  context.fillText(`${config.schoolName || 'Biblioteca escolar'} · ${data.label}`, 64, 120)
  const cardWidth = (canvas.width - margin * 2 - gapX) / columns
  data.charts.forEach((chart, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = margin + column * (cardWidth + gapX)
    const y = top + row * (cardHeight + gapY)
    context.fillStyle = palette.panel
    context.strokeStyle = palette.line
    context.lineWidth = 2
    context.fillRect(x, y, cardWidth, cardHeight)
    context.strokeRect(x, y, cardWidth, cardHeight)
    context.fillStyle = palette.text
    context.font = '700 24px Arial'
    context.fillText(chart.title, x + 24, y + 44, cardWidth - 48)

    if (chart.kind === 'donut') {
      const total = chart.data.reduce((sum, item) => sum + item.value, 0)
      const centerX = x + cardWidth / 2
      const centerY = y + cardHeight * 0.53
      const radius = Math.min(115, cardWidth * 0.22)
      let angle = -Math.PI / 2
      chart.data.forEach((item, itemIndex) => {
        if (total <= 0 || !item.value) return
        const nextAngle = angle + item.value / total * Math.PI * 2
        context.beginPath()
        context.moveTo(centerX, centerY)
        context.arc(centerX, centerY, radius, angle, nextAngle)
        context.closePath()
        context.fillStyle = palette.colors[itemIndex % palette.colors.length]
        context.fill()
        angle = nextAngle
      })
      context.beginPath()
      context.arc(centerX, centerY, radius * 0.58, 0, Math.PI * 2)
      context.fillStyle = palette.panel
      context.fill()
      context.fillStyle = palette.text
      context.textAlign = 'center'
      context.font = '700 28px Arial'
      context.fillText(String(total), centerX, centerY + 10)
      context.textAlign = 'start'
      chart.data.forEach((item, itemIndex) => {
        const legendY = y + cardHeight - 70 + itemIndex * 28
        context.fillStyle = palette.colors[itemIndex % palette.colors.length]
        context.fillRect(x + 35, legendY - 14, 18, 18)
        context.fillStyle = palette.muted
        context.font = '18px Arial'
        context.fillText(`${item.label}: ${item.value}`, x + 64, legendY, cardWidth - 90)
      })
      if (!total) {
        context.fillStyle = palette.muted
        context.textAlign = 'center'
        context.font = '20px Arial'
        context.fillText('Sem dados.', centerX, centerY + radius + 42)
        context.textAlign = 'start'
      }
      return
    }

    if (!chart.data.length) {
      context.fillStyle = palette.muted
      context.font = '20px Arial'
      context.textAlign = 'center'
      context.fillText('Sem dados no período.', x + cardWidth / 2, y + cardHeight / 2)
      context.textAlign = 'start'
      return
    }
    const items = chart.data.slice(0, 6)
    const max = Math.max(...items.map((item) => item.value), 1)
    const rowHeight = Math.min(54, (cardHeight - 90) / items.length)
    items.forEach((item, itemIndex) => {
      const rowY = y + 86 + itemIndex * rowHeight
      const labelWidth = cardWidth * 0.34
      const trackX = x + labelWidth + 36
      const trackWidth = cardWidth - labelWidth - 105
      context.fillStyle = palette.text
      context.font = '18px Arial'
      context.fillText(item.label, x + 24, rowY + 20, labelWidth - 40)
      context.fillStyle = palette.track
      context.fillRect(trackX, rowY, trackWidth, 18)
      context.fillStyle = palette.colors[0]
      context.fillRect(trackX, rowY, Math.max(item.value ? 4 : 0, trackWidth * item.value / max), 18)
      context.fillStyle = palette.text
      context.textAlign = 'right'
      context.font = '700 18px Arial'
      context.fillText(String(item.value), x + cardWidth - 24, rowY + 18)
      context.textAlign = 'start'
    })
  })
  return canvas
}

function dashboardExportFilename(suffix, extension) {
  const schoolId = String(config.currentSchoolId || 'escola').replace(/[^a-z0-9_-]/gi, '_')
  return `libris-${suffix}-${schoolId}-${new Date().toISOString().slice(0, 10)}.${extension}`
}

async function downloadDashboardChartsJpg() {
  const button = $('#downloadDashboardJpgBtn')
  const filename = dashboardExportFilename('graficos', 'jpg')
  loading(button, true, 'Preparando JPG…')
  try {
    const target = await chooseSaveTarget(filename, 'Imagem JPG', ['jpg'])
    if (!target) return
    const canvas = createDashboardExportCanvas(dashboardExportData())
    await saveBlobToTarget(await canvasToBlob(canvas), target)
  } catch (err) {
    console.error('Falha ao exportar gráficos JPG:', err)
    error(err, 'Não foi possível baixar os gráficos em JPG.')
  } finally {
    loading(button, false)
  }
}

async function downloadDashboardChartsPdf() {
  const button = $('#downloadDashboardPdfBtn')
  const filename = dashboardExportFilename('graficos', 'pdf')
  loading(button, true, 'Preparando PDF…')
  try {
    const target = await chooseSaveTarget(filename, 'Documento PDF', ['pdf'])
    if (!target) return
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
    const canvas = createDashboardExportCanvas(dashboardExportData())
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, 210, 297)
    pdf.setProperties({ title: `Gráficos gerais - ${config.schoolName}`, author: 'Libris' })
    await saveBlobToTarget(pdf.output('blob'), target)
  } catch (err) {
    console.error('Falha ao exportar gráficos PDF:', err)
    error(err, 'Não foi possível baixar os gráficos em PDF.')
  } finally {
    loading(button, false)
  }
}

async function downloadDashboardReport() {
  const button = $('#downloadDashboardReportBtn')
  const filename = dashboardExportFilename('relatorio', 'pdf')
  loading(button, true, 'Preparando relatório…')
  try {
    const target = await chooseSaveTarget(filename, 'Documento PDF', ['pdf'])
    if (!target) return
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
    const data = dashboardExportData()
    const active = data.loans.filter((loan) => loan.status === 'active')
    const overdueCount = active.filter(overdue).reduce((total, loan) => total + loanQuantity(loan), 0)
    const profileCounts = countLoanCopies(data.loans, (loan) => {
      const reader = data.readerById.get(loan.readerId)
      if (isStudentReader(reader)) return 'Alunos'
      if (isTeacherReader(reader)) return 'Professores'
      return 'Outros'
    })
    const topBooks = countLoanCopies(data.loans, (loan) => loan.bookTitle || loan.bookCode || 'Livro sem título').slice(0, 5)
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
    const left = 18
    const width = 174
    let y = 22
    const addLine = (text, options = {}) => {
      pdf.setFont('helvetica', options.bold ? 'bold' : 'normal')
      pdf.setFontSize(options.size || 11)
      const lines = pdf.splitTextToSize(String(text), width)
      const height = lines.length * (options.lineHeight || 6)
      if (y + height > 280) {
        pdf.addPage()
        y = 20
      }
      pdf.text(lines, left, y)
      y += height + (options.gap ?? 2)
    }
    addLine('Libris — Relatório da biblioteca', { bold: true, size: 18, lineHeight: 9, gap: 2 })
    addLine(config.schoolName || 'Biblioteca escolar', { bold: true, size: 13, lineHeight: 7 })
    addLine(`Período: ${data.label}`)
    addLine(`Gerado em: ${new Date().toLocaleString('pt-BR')}`)
    y += 3
    addLine('Resumo do período', { bold: true, size: 14, lineHeight: 7 })
    addLine(`Exemplares emprestados no período: ${data.loans.reduce((total, loan) => total + loanQuantity(loan), 0)}`)
    addLine(`Exemplares devolvidos no período: ${data.returns.reduce((total, loan) => total + loanQuantity(loan), 0)}`)
    addLine(`Exemplares ativos referentes ao período: ${active.reduce((total, loan) => total + loanQuantity(loan), 0)}`)
    addLine(`Exemplares em atraso entre os ativos: ${overdueCount}`)
    addLine(`Leitores cadastrados atualmente: ${state.readers.length}`)
    addLine(`Exemplares no acervo atualmente: ${state.books.reduce((sum, book) => sum + Number(book.total || 0), 0)}`)
    y += 3
    addLine('Exemplares emprestados por perfil', { bold: true, size: 14, lineHeight: 7 })
    if (profileCounts.length) profileCounts.forEach((item) => addLine(`${item.label}: ${item.value}`))
    else addLine('Sem empréstimos registrados no período.')
    y += 3
    addLine('Livros mais emprestados no período', { bold: true, size: 14, lineHeight: 7 })
    if (topBooks.length) topBooks.forEach((item, index) => addLine(`${index + 1}. ${item.label}: ${item.value}`))
    else addLine('Sem empréstimos registrados no período.')
    pdf.setProperties({ title: `Relatório Libris - ${config.schoolName}`, author: 'Libris' })
    await saveBlobToTarget(pdf.output('blob'), target)
  } catch (err) {
    console.error('Falha ao gerar relatório:', err)
    error(err, 'Não foi possível gerar o relatório PDF.')
  } finally {
    loading(button, false)
  }
}

/* -------------------------
   CRUD Admin actions
   ------------------------- */
function normalizeBookCode(value) {
  return String(value ?? '').replace(/\D+/g, '').slice(0, 4).padStart(4, '0')
}

function getLastBookSequence(prefix) {
  return state.books.reduce((lastCode, book) => {
    const [bookPrefix, sequence] = String(book.code || '').split('-')
    const numericSequence = Number(sequence)
    return bookPrefix === prefix && Number.isInteger(numericSequence) ? Math.max(lastCode, numericSequence) : lastCode
  }, 0)
}

function getLoanLimitForReader(reader = {}) {
  const isTeacher = isTeacherReader(reader)
  const configuredLimit = isTeacher ? config.maxBooksTeacher : config.maxBooksStudent
  const limit = Number(configuredLimit)
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : isTeacher ? 35 : 2
}

async function logAudit(action, details = {}, actorUid = null) {
  if (!db) return
  try {
    await addDoc(collection(db, 'audit_logs'), {
      actorUid: actorUid || state.user?.uid || null,
      schoolId: config.currentSchoolId,
      action,
      details: details || {},
      timestamp: serverTimestamp()
    })
  } catch (err) {
    console.warn('Não foi possível registrar auditoria:', err)
  }
}

/* Book form: add / edit */
async function addBook(event) {
  event.preventDefault()
  const button = $('#bookForm button[type="submit"]')
  const editingId = $('#bookIdInput')?.value
  const categoryId = $('#bookCategoryInput')?.value
  const selectedCategory = getCategoryOptions().find((c) => c.id === categoryId || c.code === categoryId)
  const title = $('#bookTitleInput')?.value.trim()
  const author = $('#bookAuthorInput')?.value.trim()
  const publisher = $('#bookPublisherInput')?.value.trim()
  const enteredIsbn = $('#bookIsbnInput')?.value.trim() || ''
  const legacyCatalogReference = $('#bookTombamentoInput')?.value.trim() || ''
  const existingBook = editingId ? state.books.find((item) => item.id === editingId) : null
  const existingMeta = editingId ? { synopsis: existingBook?.synopsis || '', coverUrl: existingBook?.coverUrl || '' } : await lookupBookMetadata(title, author, publisher)
  const book = {
    title,
    author,
    publisher,
    categoryId,
    year: Number($('#bookYearInput')?.value || 2026),
    shelf: $('#bookShelfInput')?.value.trim() || '',
    total: Number($('#bookQuantityInput')?.value || 1),
    isbn: normalizeIsbn(enteredIsbn),
    legacyCatalogReference,
    synopsis: existingMeta.synopsis,
    coverUrl: existingMeta.coverUrl
  }
  const borrowedCopies = existingBook ? Number(existingBook.total || 0) - Number(existingBook.available || 0) : 0
  if (enteredIsbn && !isValidIsbn(enteredIsbn)) return toast('Informe um ISBN-10 ou ISBN-13 válido.', 'error')
  if (!book.title || !book.author || !Number.isInteger(book.total) || book.total < 1 || book.total < borrowedCopies) return toast(book.total < borrowedCopies ? `A quantidade não pode ser menor que os ${borrowedCopies} exemplares emprestados.` : 'Preencha título, autor, categoria e quantidade válida.', 'error')

  loading(button, true, 'Salvando…')

  try {
    if (editingId) {
      const availableCopies = book.total - borrowedCopies
      await updateDoc(doc(db, 'books', editingId), { ...book, available: availableCopies, status: availableCopies ? 'disponivel' : 'emprestado', categoryName: selectedCategory?.name || categoryId, schoolId: config.currentSchoolId, updatedAt: serverTimestamp() })
      await logAudit('book_updated', { bookId: editingId, total: book.total }, state.user?.uid || null)
      resetBookForm()
      modal('bookFormModal', false)
      toast('Livro atualizado com sucesso.')
      return
    }

    const prefix = String(categoryId || 'GE').trim().toUpperCase()
    const categoryName = selectedCategory?.name || prefix
    const counterRef = doc(db, 'counters', `${encodeURIComponent(config.currentSchoolId)}_books_${prefix}`)
    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const lastCode = Math.max(Number(counterSnap.exists() ? counterSnap.data().lastCode || 0 : 0), getLastBookSequence(prefix))
      const nextCodeNumber = lastCode + 1
      const numberCode = normalizeBookCode(nextCodeNumber)
      const code = `${prefix}-${numberCode}`
      tx.set(counterRef, {
        prefix,
        schoolId: config.currentSchoolId,
        lastCode: nextCodeNumber,
        updatedAt: serverTimestamp()
      }, { merge: true })
      tx.set(doc(collection(db, 'books')), {
        ...book,
        code,
        categoryId: prefix,
        categoryName: categoryName,
        schoolId: config.currentSchoolId,
        available: book.total,
        total: book.total,
        status: 'disponivel',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    })
    
    await logAudit('book_created', { title: book.title, categoryId: book.categoryId, total: book.total }, state.user?.uid || null)
    resetBookForm()
    modal('bookFormModal', false)
    toast('Livro cadastrado com sucesso.')
  } catch (err) { error(err, 'Não foi possível salvar o livro.') } finally { loading(button, false) }
}

/* Categories */
async function addCategory(event) {
  event.preventDefault()
  const button = $('#categoryForm button[type="submit"]')
  const name = $('#categoryNameInput')?.value.trim()
  const code = $('#categoryCodeInput')?.value.trim()
  if (!name || !code) return toast('Informe nome e código da categoria.', 'error')
  const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
  if (!normalizedCode) return toast('Código inválido para categoria.', 'error')
  if (getCategoryOptions().some((category) => category.name.toLowerCase() === name.toLowerCase() || category.code?.toLowerCase() === normalizedCode.toLowerCase())) return toast('Essa categoria já existe.', 'error')
  loading(button, true, 'Salvando…')
  try {
    const categoryRef = doc(db, 'categories', `${encodeURIComponent(config.currentSchoolId)}__${normalizedCode}`)
    await setDoc(categoryRef, { id: normalizedCode, name, code: normalizedCode, schoolId: config.currentSchoolId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true })
    if ($('#categoryForm')) $('#categoryForm').reset(); 
    renderCategorySelect(); 
    renderCategoryList(); 
    modal('categoryModal', false);
    toast('Categoria salva com sucesso.')
  } catch (err) { error(err, 'Não foi possível salvar a categoria.') } finally { loading(button, false) }
}

async function removeCategory(id) {
  if (!confirm('Apagar esta categoria?')) return
  try {
    await deleteDoc(doc(db, 'categories', id))
    toast('Categoria apagada.')
  } catch (err) { error(err, 'Não foi possível apagar a categoria.') }
}

/* Readers */
async function addReader(event) {
  event.preventDefault()
  const button = $('#readerForm button[type="submit"]')
  const editingId = $('#readerIdInput')?.value
  const type = $('#readerTypeInput')?.value || 'Aluno'
  const role = type === 'Aluno' ? 'student' : type === 'Professor' ? 'teacher' : 'other'
  const reader = {
    schoolId: config.currentSchoolId,
    name: $('#readerNameInput')?.value.trim(),
    type,
    role,
    class: type === 'Aluno' ? $('#readerCourseInput')?.value.trim() : '',
    course: type === 'Aluno' ? $('#readerCourseInput')?.value.trim() : '',
    matricula: type === 'Aluno' ? $('#readerRegistrationInput')?.value.trim() : '',
    cpf: type !== 'Aluno' ? $('#readerCpfInput')?.value.trim() : '',
    email: $('#readerEmailInput')?.value.trim(),
    phone: $('#readerPhoneInput')?.value.trim()
  }
  if (!reader.name || !reader.email || !reader.phone || (type === 'Aluno' && (!reader.course || !reader.matricula)) || (type !== 'Aluno' && !reader.cpf)) return toast('Preencha todos os campos obrigatórios.', 'error')
  loading(button, true, editingId ? 'Atualizando…' : 'Salvando…')
  try {
    if (editingId) {
      await updateDoc(doc(db, 'readers', editingId), { ...reader, updatedAt: serverTimestamp() })
      resetReaderForm()
      modal('readerFormModal', false)
      toast('Leitor atualizado com sucesso.')
    } else {
      await addDoc(collection(db, 'readers'), { ...reader, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
      resetReaderForm()
      modal('readerFormModal', false)
      toast('Leitor cadastrado com sucesso.')
    }
  } catch (err) { error(err, 'Não foi possível salvar o leitor.') } finally { loading(button, false) }
}

/* Remove book / reader */
async function removeBook(id) {
  if (state.loans.some((loan) => loan.bookId === id && loan.status === 'active')) return toast('Não é possível apagar um livro com empréstimo ativo.', 'error')
  if (!confirm('Apagar este livro?')) return
  try { await deleteDoc(doc(db, 'books', id)); toast('Livro apagado.') } catch (err) { error(err, 'Não foi possível apagar o livro.') }
}

async function removeReader(id) {
  if (state.loans.some((loan) => loan.readerId === id && loan.status === 'active')) return toast('Não é possível apagar um leitor com empréstimo ativo.', 'error')
  if (!confirm('Apagar este leitor?')) return
  try { await deleteDoc(doc(db, 'readers', id)); toast('Leitor apagado.') } catch (err) { error(err, 'Não foi possível apagar o leitor.') }
}

/* Loans */
async function registerLoan() {
  if (loanRegistrationPending) return
  loanRegistrationPending = true
  try {
    await submitLoan()
  } finally {
    loanRegistrationPending = false
  }
}

let loanRegistrationPending = false

async function submitLoan() {
  const button = $('#registerLoanBtn')
  const code = $('#bookCodeInput')?.value.trim().toUpperCase()
  const text = $('#readerInput')?.value.trim()
  const selectedReaderId = $('#loanReaderIdInput')?.value
  const days = Number($('#loanDays')?.value)
  const book = state.books.find((b) => b.code?.toUpperCase() === code)
  const reader = selectedReaderId ? state.readers.find((r) => r.id === selectedReaderId) : state.readers.find((r) => r.matricula === text || r.name?.toLocaleLowerCase('pt-BR') === text?.toLocaleLowerCase('pt-BR'))

  if (!book || !reader) {
    return toast(!book ? 'Livro não encontrado.' : 'Leitor não encontrado.', 'error')
  }

  const quantity = Number($('#loanQuantityInput')?.value || 1)
  const loanLimit = getLoanLimitForReader(reader)

  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return toast('Informe uma quantidade inteira de exemplares maior que zero.', 'error')
  }

  let activeLoansSnap
  try {
    activeLoansSnap = await getDocs(query(
      collection(db, 'loans'),
      where('schoolId', '==', config.currentSchoolId),
      where('readerId', '==', reader.id),
      where('status', '==', 'active')
    ))
  } catch (err) {
    error(err, 'Não foi possível validar os empréstimos ativos deste leitor.')
    return
  }

  const activeLoans = activeLoansSnap.docs.map((loanDoc) => ({ id: loanDoc.id, ...loanDoc.data() }))
  const availableCopies = Number(book.available ?? 0)
  const quantityLimit = getLoanQuantityLimit({
    loanLimit,
    activeLoans,
    readerId: reader.id,
    availableCopies
  })
  if (quantity > quantityLimit.maximum) {
    return toast(`Máximo permitido agora: ${quantityLimit.maximum} exemplar(es). O leitor já possui ${quantityLimit.activeCopies} de ${loanLimit} permitido(s), e há ${availableCopies} exemplar(es) disponível(is) deste título.`, 'error')
  }

  const maxLoanDays = getMaxLoanDaysForReader(reader)
  if (!Number.isSafeInteger(days) || days < 1 || (maxLoanDays !== null && days > maxLoanDays)) {
    updateLoanDaysLimit(reader)
    const message = maxLoanDays === null
      ? 'Informe um prazo em dias como número inteiro maior que zero.'
      : `O prazo deve ser entre 1 e ${maxLoanDays} dias para este perfil.`
    return toast(message, 'error')
  }

  loading(button, true, 'Registrando…')

  try {
    await runTransaction(db, async (tx) => {
      const bookRef = doc(db, 'books', book.id)
      const bookSnap = await tx.get(bookRef)

      const availableCopies = Number(bookSnap.data()?.available || 0)
      if (!bookSnap.exists() || availableCopies < quantity) {
        throw new Error('indisponível')
      }

      const due = new Date()
      const effectiveDays = days
      due.setDate(due.getDate() + effectiveDays)
      if (Number.isNaN(due.getTime())) throw new Error('prazo inválido')

      tx.update(bookRef, {
        available: increment(-quantity),
        status: availableCopies - quantity > 0 ? 'disponivel' : 'emprestado',
        schoolId: bookSnap.data().schoolId || config.currentSchoolId,
        updatedAt: serverTimestamp()
      })

      tx.set(doc(collection(db, 'loans')), {
        schoolId: config.currentSchoolId,
        bookId: book.id,
        bookCode: book.code,
        bookTitle: book.title,
        readerId: reader.id,
        readerName: reader.name,
        readerCourse: reader.course || 'Não se aplica',
        readerEmail: reader.email || '',
        quantity,
        days: effectiveDays,
        dueDate: Timestamp.fromDate(due),
        dueAt: Timestamp.fromDate(due),
        status: 'active',
        notices: {},
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    })

    await logAudit('loan_created', { bookId: book.id, readerId: reader.id, quantity, days }, state.user?.uid || null)
    if ($('#bookCodeInput')) $('#bookCodeInput').value = ''
    if ($('#readerInput')) $('#readerInput').value = ''
    if ($('#loanReaderIdInput')) $('#loanReaderIdInput').value = ''
    if ($('#loanQuantityInput')) $('#loanQuantityInput').value = '1'
    updateLoanQuantityLimit(null)
    updateLoanDaysLimit(null, true)
    if ($('#readerSuggestions')) $('#readerSuggestions').hidden = true
    if ($('#bookCodeInput')) $('#bookCodeInput').focus()
    toast('Empréstimo registrado.')
  } catch (err) {
    if (err.message === 'indisponível') {
      toast('Livro indisponível.', 'error')
      return
    }
    error(err, 'Não foi possível registrar o empréstimo.')
  } finally {
    loading(button, false)
  }
}

async function returnLoan(id) {
  try {
    await runTransaction(db, async (tx) => {
      const loanRef = doc(db, 'loans', id)
      const loanSnap = await tx.get(loanRef)
      if (!loanSnap.exists() || loanSnap.data().status !== 'active') throw new Error('inválido')
      const quantity = loanQuantity(loanSnap.data())
      const bookRef = doc(db, 'books', loanSnap.data().bookId)
      const bookSnap = await tx.get(bookRef)

      tx.update(loanRef, { status: 'returned', returnedAt: serverTimestamp(), updatedAt: serverTimestamp(), schoolId: loanSnap.data().schoolId || config.currentSchoolId })

      if (bookSnap.exists()) {
        const free = Math.min(Number(bookSnap.data().available || 0) + quantity, Number(bookSnap.data().total || 0))
        tx.update(bookRef, { available: free, status: free ? 'disponivel' : 'emprestado', updatedAt: serverTimestamp(), schoolId: bookSnap.data().schoolId || config.currentSchoolId })
      }
    })
    await logAudit('loan_returned', { loanId: id }, state.user?.uid || null)
    toast('Livro devolvido.')
  } catch (err) {
    error(err, 'Não foi possível registrar a devolução.')
  }
}

async function renewLoan(id) {
  const loan = state.loans.find((l) => l.id === id)
  if (!loan) return
  const select = document.querySelector?.(`[data-renew-days="${id}"]`)
  const days = Number(select?.value || loan.days || 7)
  const reader = state.readers.find((item) => item.id === loan.readerId)
  const maximum = getMaxLoanDaysForReader(reader)
  if (!Number.isSafeInteger(days) || days < 1 || (maximum !== null && days > maximum)) {
    toast(maximum === null
      ? 'Informe um prazo em dias como número inteiro maior que zero.'
      : `A renovação deve ser entre 1 e ${maximum} dias para este perfil.`, 'error')
    return
  }
  try {
    const due = extendLoanDueDate(loan, days)
    await updateDoc(doc(db, 'loans', id), {
      days,
      dueDate: Timestamp.fromDate(due),
      dueAt: Timestamp.fromDate(due),
      notices: {},
      schoolId: config.currentSchoolId,
      updatedAt: serverTimestamp()
    })
    await logAudit('loan_renewed', { loanId: id, days }, state.user?.uid || null)
    toast(`Renovação concluída por ${days} dias.`)
  } catch (err) { error(err, 'Não foi possível renovar o empréstimo.') }
}

/* Notifications */
function normalizePhone(phone = '') {
  return String(phone || '').replace(/\D/g, '')
}

async function openWhatsAppMessage(reader, message) {
  let phone = normalizePhone(reader?.phone)
  if (!phone) {
    toast('Este leitor não possui telefone cadastrado para WhatsApp.', 'error')
    return false
  }

  if (phone.length === 10 || phone.length === 11) {
    phone = `55${phone}`
  } else if (!phone.startsWith('55') || ![12, 13].includes(phone.length)) {
    toast('O telefone precisa incluir um número brasileiro válido com DDD.', 'error')
    return false
  }

  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
  try {
    if (isTauri()) {
      await open(url)
    } else {
      const openedWindow = window.open(url, '_blank')
      if (!openedWindow) throw new Error('A janela do WhatsApp foi bloqueada pelo navegador.')
    }
    return true
  } catch (err) {
    console.error('Falha ao abrir o WhatsApp:', err)
    toast('Não foi possível abrir o link do WhatsApp.', 'error')
    return false
  }
}

const EMAIL_AUDIT_LIMIT = 100

async function logSentEmail(recipient, subject) {
  const sentAt = new Date()
  await localStore.put('email_logs', {
    id: `${sentAt.getTime()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`,
    schoolId: config.currentSchoolId,
    recipient,
    subject,
    sentAt: sentAt.toISOString(),
    status: 'sent'
  })

  const schoolLogs = (await localStore.list('email_logs'))
    .filter((record) => record.schoolId === config.currentSchoolId)
    .sort((left, right) => new Date(right.sentAt).getTime() - new Date(left.sentAt).getTime())
  await Promise.all(schoolLogs.slice(EMAIL_AUDIT_LIMIT).map((record) => localStore.remove('email_logs', record.id)))
}

async function sendEmailNotification(recipient, subject, message, htmlBody) {
  const email = String(recipient || '').trim()
  const smtp = config.smtp || {}
  if (!email) {
    toast('Endereço de e-mail não informado.', 'error')
    return { sent: false, audited: false }
  }
  if (!isTauri()) {
    toast('O envio SMTP está disponível apenas no aplicativo desktop Libris.', 'error')
    return { sent: false, audited: false }
  }
  if (!smtp.host || !smtp.username || ![465, 587].includes(Number(smtp.port))) {
    toast('Configure host, porta e usuário SMTP na administração CREDE.', 'error')
    return { sent: false, audited: false }
  }

  try {
    await invoke('send_email', {
      schoolId: config.currentSchoolId,
      smtpHost: smtp.host,
      smtpPort: Number(smtp.port),
      smtpUsername: smtp.username,
      recipient: email,
      subject,
      body: message,
      htmlBody
    })
  } catch (err) {
    console.error('Falha no envio SMTP:', err)
    toast(typeof err === 'string' ? err : 'Não foi possível enviar o e-mail. Verifique a configuração SMTP e a conexão.', 'error')
    return { sent: false, audited: false }
  }

  try {
    await logSentEmail(email, subject)
    return { sent: true, audited: true }
  } catch (err) {
    console.error('E-mail enviado, mas a auditoria local falhou:', err)
    return { sent: true, audited: false }
  }
}

async function sendEmailFromButton(button, recipient, subject, message, htmlBody) {
  loading(button, true, 'Enviando…')
  try {
    return await sendEmailNotification(recipient, subject, message, htmlBody)
  } finally {
    loading(button, false)
  }
}

async function updateEmailCredentialStatus(elementId, schoolId = config.currentSchoolId) {
  const status = $(`#${elementId}`)
  if (!status) return
  if (!isTauri()) {
    status.textContent = 'Configure e envie e-mails pelo aplicativo desktop Libris.'
    return
  }
  if (elementId === 'notificationEmailStatus' && (!config.smtp?.host || !config.smtp?.username)) {
    status.textContent = 'Servidor SMTP não configurado. Solicite a configuração à administração CREDE.'
    return
  }
  if (!schoolId) {
    status.textContent = 'Cadastre a escola para consultar o cofre seguro.'
    return
  }

  try {
    const saved = await invoke('has_smtp_password', { schoolId })
    status.textContent = saved
      ? 'Senha de app guardada no cofre seguro do sistema.'
      : 'Nenhuma senha SMTP salva no cofre seguro.'
  } catch (err) {
    console.error('Falha ao consultar a senha SMTP:', err)
    status.textContent = 'Não foi possível consultar o cofre seguro do sistema.'
  }
}

async function removeSmtpPassword() {
  const schoolId = $('#librisConfigForm')?.dataset.schoolId || ''
  if (!schoolId) return toast('Cadastre a escola antes de remover a senha salva.', 'error')
  if (!isTauri()) return toast('O cofre de credenciais só está disponível no aplicativo desktop Libris.', 'error')
  if (!confirm('Remover a senha SMTP salva no cofre seguro deste computador?')) return

  try {
    await invoke('delete_smtp_password', { schoolId })
    await updateEmailCredentialStatus('librisSmtpCredentialStatus', schoolId)
    toast('Senha SMTP removida do cofre seguro.')
  } catch (err) {
    error(err, 'Não foi possível remover a senha SMTP do cofre seguro.')
  }
}

async function triggerNotification(type) {
  const notificationModal = $('#notificationModal')
  const loanId = notificationModal?.dataset.loanId
  const loan = state.loans.find((item) => item.id === loanId)
  const reader = state.readers.find((item) => item.id === loan?.readerId)
  const message = $('#notificationMessage')?.value.trim()

  if (!loan || !reader || !message) {
    return toast('Não foi possível enviar a notificação. Empréstimo ou leitor não encontrado.', 'error')
  }

  if (type === 'coordination') {
    const coordEmail = (config.coordinationEmail || $('#coordinationEmailInput')?.value || '').trim()

    if (!coordEmail) {
      return toast('Cadastre e salve o e-mail da coordenação nas configurações da escola.', 'error')
    }

    const coordination = { 
      name: 'Coordenação', 
      email: coordEmail 
    }

    const subject = `Empréstimo em atraso - ${config.schoolName}`
    const coordinationMessage = `Olá, coordenação. O empréstimo de ${loanQuantity(loan)} exemplar(es) do livro "${loan.bookTitle}" para o(a) leitor(a) ${loan.readerName} está em atraso desde ${formatDate(getLoanDueDate(loan))}.`
    const dueDate = date(getLoanDueDate(loan))
    const daysOverdue = dueDate && !Number.isNaN(dueDate.getTime())
      ? Math.max(0, Math.ceil((Date.now() - dueDate.getTime()) / 86400000))
      : 0
    const htmlBody = createCoordinationEmailHtml({
      subject,
      schoolName: config.schoolName,
      message: coordinationMessage,
      readerName: loan.readerName,
      bookTitle: loan.bookTitle,
      dueDate: formatDate(getLoanDueDate(loan)),
      daysOverdue
    })
    const result = await sendEmailFromButton($('#sendCoordinationBtn'), coordination.email, subject, coordinationMessage, htmlBody)

    if (!result.sent) return
    toast(result.audited ? 'Aviso enviado à coordenação com sucesso!' : 'Aviso enviado, mas o registro local de auditoria falhou.')
    modal('notificationModal', false)
    return
  }

  if (type === 'whatsapp') {
    const sent = await openWhatsAppMessage(reader, message)
    if (!sent) return

    toast('WhatsApp aberto com a mensagem.')
    modal('notificationModal', false)
    return
  }

  if (!reader.email || !reader.email.trim()) {
    return toast(`O leitor ${reader.name} não possui e-mail cadastrado na aba Leitores.`, 'error')
  }

  const subject = `Aviso da biblioteca - ${config.schoolName}`
  const htmlBody = createStudentEmailHtml({
    subject,
    schoolName: config.schoolName,
    message,
    bookTitle: loan.bookTitle,
    dueDate: formatDate(getLoanDueDate(loan)),
    loanDays: Number(loan.days || 7)
  })
  const result = await sendEmailFromButton($('#sendEmailBtn'), reader.email, subject, message, htmlBody)

  if (!result.sent) return
  toast(result.audited ? 'E-mail enviado ao leitor com sucesso!' : 'E-mail enviado, mas o registro local de auditoria falhou.')
  modal('notificationModal', false)
}

/* -------------------------
   CSV import / export
   ------------------------- */
const bookExportFields = [
  ['ID do documento', 'documentId'],
  ['Código', 'code'],
  ['Título', 'title'],
  ['Autor', 'author'],
  ['Editora', 'publisher'],
  ['ID da categoria', 'categoryId'],
  ['Categoria', 'categoryName'],
  ['Sinopse', 'synopsis'],
  ['URL da capa', 'coverUrl'],
  ['Ano', 'year'],
  ['Localização', 'shelf'],
  ['Disponíveis', 'available'],
  ['Total', 'total'],
  ['ISBN', 'isbn'],
  ['Referência anterior', 'legacyCatalogReference'],
  ['Status', 'status'],
  ['ID da escola', 'schoolId'],
  ['Nome da escola', 'schoolName'],
  ['Criado em', 'createdAt'],
  ['Atualizado em', 'updatedAt']
]

function exportValue(value) {
  if (value?.toDate) return value.toDate().toISOString()
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') return JSON.stringify(value, (_, nested) => nested?.toDate ? nested.toDate().toISOString() : nested)
  return value ?? ''
}

const bookExportRows = () => [
  bookExportFields.map(([header]) => header),
  ...state.books.map((book) => bookExportFields.map(([, field]) => {
    if (field === 'documentId') return book.id || ''
    if (field === 'categoryName') return book.categoryName || label(book.categoryId)
    if (field === 'status') return bookStatus(book)
    if (field === 'schoolName') return config.schoolName
    if (field === 'legacyCatalogReference') return book.legacyCatalogReference || book.tombamento || ''
    return exportValue(book[field])
  }))
]

function recordsToExportRows(records = [], excludedFields = []) {
  const excluded = new Set(excludedFields)
  const fields = [...new Set(records.flatMap((record) => Object.keys(record)))].filter((field) => !excluded.has(field)).sort()
  return [fields, ...records.map((record) => fields.map((field) => exportValue(record[field])))]
}

async function schoolBackupTables() {
  if (!state.profile || state.profile.role !== 'admin' || !config.currentSchoolId) throw new Error('Acesse com um administrador vinculado a uma escola.')

  const collectionNames = ['readers', 'reservations', 'counters', 'audit_logs', 'email_logs']
  const [schoolSnapshot, ...snapshots] = await Promise.all([
    getDoc(doc(db, 'schools', config.currentSchoolId)),
    ...collectionNames.map((name) => getDocs(query(collection(db, name), where('schoolId', '==', config.currentSchoolId))))
  ])
  const schoolData = schoolSnapshot.exists() ? schoolSnapshot.data() : {}
  const collectionRecords = Object.fromEntries(collectionNames.map((name, index) => [
    name,
    snapshots[index].docs.map((item) => ({ id: item.id, ...item.data() }))
  ]))

  return [
    ['Acervo', bookExportRows()],
    ['Emprestimos', recordsToExportRows(state.loans)],
    ['Leitores', recordsToExportRows(collectionRecords.readers)],
    ['Categorias', recordsToExportRows(state.categories)],
    ['Reservas', recordsToExportRows(collectionRecords.reservations)],
    ['Contadores', recordsToExportRows(collectionRecords.counters)],
    ['Auditoria', recordsToExportRows(collectionRecords.audit_logs)],
    ['E-mails enviados', recordsToExportRows(collectionRecords.email_logs)],
    ['Escola', recordsToExportRows([{ id: config.currentSchoolId, ...schoolData, schoolId: config.currentSchoolId }])]
  ]
}

function csvFromRows(rows) {
  return rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(';')).join('\n')
}

function backupFileBaseName() {
  const schoolId = String(config.currentSchoolId || 'escola').replace(/[^a-z0-9_-]/gi, '_')
  return `libris-backup-${schoolId}-${new Date().toISOString().slice(0, 10)}`
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.94) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Não foi possível converter a imagem para download.'))
        return
      }
      resolve(blob)
    }, type, quality)
  })
}

function fileMimeType(extension) {
  return ({
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
    zip: 'application/zip'
  })[extension] || 'application/octet-stream'
}

async function chooseSaveTarget(filename, filterName, extensions) {
  if (isTauri()) {
    const path = await save({
      title: 'Salvar arquivo do Libris',
      defaultPath: filename,
      filters: [{ name: filterName, extensions }]
    })
    return path ? { kind: 'tauri', path } : null
  }

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: filterName,
          accept: { [fileMimeType(extensions[0])]: extensions.map((extension) => `.${extension}`) }
        }]
      })
      return { kind: 'web', handle }
    } catch (err) {
      if (err.name === 'AbortError') return null
      throw err
    }
  }

  return { kind: 'browser', filename }
}

async function saveBlobToTarget(blob, target) {
  if (!target) return false

  if (target.kind === 'tauri') {
    await writeFile(target.path, new Uint8Array(await blob.arrayBuffer()))
    toast(`Arquivo salvo em: ${target.path}`)
    return true
  }

  if (target.kind === 'web') {
    const writable = await target.handle.createWritable()
    await writable.write(blob)
    await writable.close()
    toast(`Arquivo salvo: ${target.handle.name}`)
    return true
  }

  downloadBlob(blob, target.filename)
  toast(`Download de ${target.filename} iniciado. A localização depende das configurações de downloads do navegador.`)
  return true
}

async function exportCsv() {
  const button = $('#exportCsvOption')
  const filename = `${backupFileBaseName()}.zip`
  loading(button, true, 'Preparando backup…')
  try {
    const target = await chooseSaveTarget(filename, 'Backup Libris', ['zip'])
    if (!target) return
    const blob = await createCsvBackupArchive()
    const saved = await saveBlobToTarget(blob, target)
    if (saved) {
      modal('exportModal', false)
    }
  } catch (err) {
    console.error('Falha ao exportar backup CSV:', err)
    error(err, 'Não foi possível gerar o backup CSV da escola.')
  } finally {
    loading(button, false)
  }
}

async function createCsvBackupArchive() {
  const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')
  const collectionsByTable = {
    Acervo: 'books',
    Emprestimos: 'loans',
    Leitores: 'readers',
    Categorias: 'categories',
    Reservas: 'reservations',
    Contadores: 'counters',
    Auditoria: 'audit_logs',
    'E-mails enviados': 'email_logs',
    Escola: 'schools'
  }
  const tables = await schoolBackupTables()
  const zip = new JSZip()
  tables.forEach(([name, rows]) => {
    const collectionName = collectionsByTable[name]
    const filename = Object.entries({ ...backupCollectionFiles, ...optionalBackupCollectionFiles }).find(([, value]) => value === collectionName)?.[0]
    if (!filename) throw new Error(`Não há arquivo CSV definido para ${name}.`)
    zip.file(filename, `\ufeff${csvFromRows(rows)}`)
  })
  zip.file('LEIA-ME.txt', `Backup escolar Libris\nEscola: ${config.schoolName}\nID: ${config.currentSchoolId}\nGerado em: ${new Date().toISOString()}\n\nCada arquivo CSV corresponde a uma coleção. Para restaurar, use Importar e selecione este ZIP. As credenciais locais nao sao exportadas; a restauracao preserva as contas cadastradas neste computador.`)
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

async function restoreCsvBackup(file) {
  if (!state.user || !config.currentSchoolId) throw new Error('Entre no painel da escola antes de restaurar um backup.')
  if (!confirm(`O backup CSV substituirá os dados locais de ${config.schoolName}. Deseja continuar?`)) return

  const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')
  const zip = await JSZip.loadAsync(file)
  const missingFiles = Object.keys(backupCollectionFiles).filter((filename) => !zip.file(filename))
  if (missingFiles.length) throw new Error(`Backup incompleto. Arquivos ausentes: ${missingFiles.join(', ')}.`)
  const collections = {}
  for (const [filename, collectionName] of Object.entries({ ...backupCollectionFiles, ...optionalBackupCollectionFiles })) {
    const entry = zip.file(filename)
    if (!entry) continue
    const workbook = XLSX.read(await entry.async('arraybuffer'), { type: 'array', raw: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true }) : []
    const headers = (rows[0] || []).map((value) => String(value ?? '').replace(/^\uFEFF/, '').trim())
    collections[collectionName] = rows.slice(1)
      .filter((row) => row.some((value) => String(value ?? '').trim()))
      .map((row) => {
        const record = collectionName === 'books'
          ? backupRecordFromRow(headers, row, collectionName)
          : Object.fromEntries(headers.map((header, index) => [header, parseBackupCell(row[index])]).filter(([key]) => key))
        record.schoolId = config.currentSchoolId
        if (collectionName === 'categories') record.id = `${encodeURIComponent(config.currentSchoolId)}__${record.code || record.id}`
        if (collectionName === 'counters') record.id = `${encodeURIComponent(config.currentSchoolId)}_books_${record.prefix}`
        if (collectionName === 'email_usage') record.id = `${config.currentSchoolId}_${record.month}`
        if (collectionName === 'schools') {
          record.id = config.currentSchoolId
          record.name = record.name || config.schoolName
        }
        return record
      })
  }
  if (!collections.schools?.length) throw new Error('O arquivo não contém escola.csv; selecione um backup completo do Libris.')
  collections.users = (await localStore.list('users')).filter((user) => user.schoolId === config.currentSchoolId)

  await localStore.replaceSchool(config.currentSchoolId, {
    schemaVersion: 1,
    schoolId: config.currentSchoolId,
    exportedAt: new Date().toISOString(),
    collections
  })
  if (!await loadSchoolData(config.currentSchoolId)) throw new Error('Não foi possível carregar as configurações restauradas.')
  await subscribeAdmin()
  toast('Backup CSV restaurado nesta máquina.')
}

const normalizeCsvHeader = (value) => String(value ?? '').replace(/^\uFEFF/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const csvHeaderAliases = {
  documentId: ['id do documento', 'document id', 'documentid', 'firestore id'],
  codigo: ['codigo', 'codigo do livro', 'codigo do acervo', 'id', 'id do livro', 'cod'],
  titulo: ['titulo', 'titulo do livro', 'nome do livro', 'livro'],
  autor: ['autor', 'nome do autor'],
  editora: ['editora', 'publisher'],
  categoriaId: ['id da categoria', 'categoria id', 'category id', 'categoryid'],
  categoriaNome: ['nome da categoria', 'category name', 'categoryname'],
  categoria: ['categoria', 'genero', 'assunto', 'category'],
  ano: ['ano', 'ano de publicacao', 'ano publicacao'],
  localizacao: ['localizacao', 'estante', 'prateleira', 'local'],
  disponiveis: ['disponiveis', 'quantidade disponivel', 'exemplares disponiveis'],
  total: ['total', 'quantidade', 'quantidade total', 'quantidade de exemplares', 'exemplares'],
  isbn: ['isbn', 'isbn 10', 'isbn 13', 'numero isbn'],
  legacyCatalogReference: ['referencia anterior', 'referencia legada', 'tombamento', 'numero de tombamento', 'patrimonio'],
  sinopse: ['sinopse', 'synopsis'],
  capa: ['url da capa', 'capa url', 'cover url', 'coverurl'],
  schoolId: ['id da escola', 'school id', 'schoolid'],
  schoolName: ['nome da escola', 'school name', 'schoolname'],
  criadoEm: ['criado em', 'created at', 'createdat'],
  atualizadoEm: ['atualizado em', 'updated at', 'updatedat']
}

function mapCsvColumns(headers) {
  const columns = {}
  headers.forEach((header, index) => {
    const normalized = normalizeCsvHeader(header)
    const field = Object.entries(csvHeaderAliases).find(([, aliases]) => aliases.includes(normalized))?.[0]
    if (field && columns[field] === undefined) columns[field] = index
  })
  return columns
}

function parseCsvInteger(value) { const text = String(value ?? '').trim(); if (!/^\d+$/.test(text)) return null; const number = Number(text); return Number.isSafeInteger(number) ? number : null }
function parseCsvDate(value) { const text = String(value ?? '').trim(); if (!text) return null; const parsed = new Date(text); return Number.isNaN(parsed.getTime()) ? null : parsed }

async function importCsv(event) {
  const input = event.target
  const file = input?.files?.[0]
  if (!file) return
  toast(`Lendo arquivo: ${file.name}`)
  modal('importCsvFileModal', false)
  if (!db || !state.user) { if (input) input.value = ''; return toast('Entre no painel administrativo para importar dados.', 'error') }
  if (file.name.toLowerCase().endsWith('.zip')) {
    try {
      await restoreCsvBackup(file)
    } catch (err) {
      error(err, 'Não foi possível restaurar o backup CSV.')
    } finally {
      if (input) input.value = ''
    }
    return
  }

  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true }) : []
    if (rows.length < 2) return toast('O CSV está vazio ou não contém linhas de livros.', 'error')

    const headerRowIndex = rows.findIndex((row) => {
      const columns = mapCsvColumns(row)
      return columns.codigo !== undefined && columns.titulo !== undefined
    })
    if (headerRowIndex < 0) {
      const preview = rows.slice(0, 3).map((row) => row.filter(Boolean).join(', ')).filter(Boolean).join(' / ')
      if (input) input.value = ''
      return toast(`Não encontrei as colunas Código e Título. Cabeçalhos lidos: ${preview || 'nenhum'}.`, 'error')
    }

    const columns = mapCsvColumns(rows[headerRowIndex])
    const required = ['codigo', 'titulo', 'autor', 'total']
    const missing = required.filter((header) => columns[header] === undefined)
    if (missing.length) {
      const detected = rows[headerRowIndex].filter(Boolean).join(', ')
      if (input) input.value = ''
      return toast(`Colunas obrigatórias ausentes: ${missing.join(', ')}. Cabeçalhos lidos: ${detected}.`, 'error')
    }

    const existingCodes = new Set(state.books.map((book) => String(book.code || '').trim().toUpperCase()))
    const existingDocumentIds = new Set(state.books.map((book) => book.id).filter(Boolean))
    const seenCodes = new Set()
    const booksToImport = []
    const countersToUpdate = new Map()
    const categoriesToCreate = new Map()
    const skipped = []
    const errors = []
    const valueAt = (row, key) => columns[key] === undefined ? '' : String(row[columns[key]] ?? '').trim()

    rows.slice(headerRowIndex + 1).forEach((row, index) => {
      if (!row.some((value) => String(value ?? '').trim())) return
      const line = headerRowIndex + index + 2
      const code = valueAt(row, 'codigo').toUpperCase()
      const sourceDocumentId = valueAt(row, 'documentId')
      const codeParts = code.match(/^([A-Z0-9]{1,4})-(\d{4})$/)
      const title = valueAt(row, 'titulo')
      const author = valueAt(row, 'autor')
      const categoryName = valueAt(row, 'categoria') || valueAt(row, 'categoriaNome')
      const categoryId = valueAt(row, 'categoriaId')
      const categoryResolution = resolveLegacyCategory({
        name: categoryName,
        categoryId,
        code,
        categories: [...getCategoryOptions(), ...categoriesToCreate.values()]
      })
      const category = categoryResolution.category
      const total = parseCsvInteger(valueAt(row, 'total'))
      const availableValue = valueAt(row, 'disponiveis')
      const available = availableValue ? parseCsvInteger(availableValue) : total
      const yearValue = valueAt(row, 'ano')
      const year = yearValue ? parseCsvInteger(yearValue) : 0
      const sourceSchoolId = valueAt(row, 'schoolId')
      const createdAtValue = valueAt(row, 'criadoEm')
      const updatedAtValue = valueAt(row, 'atualizadoEm')
      const createdAt = parseCsvDate(createdAtValue)
      const updatedAt = parseCsvDate(updatedAtValue)

      const rowErrors = []
      if (!codeParts) rowErrors.push('código deve seguir PREFIXO-0001')
      if (!title) rowErrors.push('título ausente')
      if (!author) rowErrors.push('autor ausente')
      if (!categoryName && !categoryId) rowErrors.push('categoria ausente')
      else if (categoryResolution.error) rowErrors.push(categoryResolution.error)
      if (total === null || total < 1) rowErrors.push('total inválido')
      if (available === null || available > total) rowErrors.push('disponíveis deve estar entre 0 e o total')
      if (year === null) rowErrors.push('ano inválido')
      if (createdAtValue && !createdAt) rowErrors.push('data de criação inválida')
      if (updatedAtValue && !updatedAt) rowErrors.push('data de atualização inválida')
      if (sourceDocumentId && (sourceDocumentId.includes('/') || sourceDocumentId.length > 1500)) rowErrors.push('ID do documento inválido')
      if (rowErrors.length) {
        errors.push(`linha ${line} (${rowErrors.join(', ')})`)
        return
      }
      if (seenCodes.has(code)) {
        errors.push(`linha ${line} (código repetido no arquivo: ${code})`)
        return
      }
      seenCodes.add(code)
      if (categoryResolution.create) categoriesToCreate.set(category.code, category)
      if (existingCodes.has(code)) {
        skipped.push(code)
        return
      }

      const documentId = sourceDocumentId && !existingDocumentIds.has(sourceDocumentId) ? sourceDocumentId : ''
      if (documentId) existingDocumentIds.add(documentId)

      booksToImport.push({
        documentId,
        code,
        title,
        author,
        publisher: valueAt(row, 'editora'),
        categoryId: String(category.code || category.id),
        categoryName: category.name || categoryName || categoryId,
        year,
        shelf: valueAt(row, 'localizacao'),
        available,
        total,
        isbn: normalizeIsbn(valueAt(row, 'isbn')),
        legacyCatalogReference: valueAt(row, 'legacyCatalogReference'),
        synopsis: valueAt(row, 'sinopse'),
        coverUrl: valueAt(row, 'capa'),
        status: available > 0 ? 'disponivel' : 'emprestado',
        createdAt: createdAt ? Timestamp.fromDate(createdAt) : null,
        updatedAt: updatedAt ? Timestamp.fromDate(updatedAt) : null,
        schoolId: config.currentSchoolId,
        importedFromSchoolId: sourceSchoolId || ''
      })
      const [prefix, codeNumber] = [codeParts[1], Number(codeParts[2])]
      countersToUpdate.set(prefix, Math.max(countersToUpdate.get(prefix) || 0, codeNumber))
    })

    if (errors.length) { if (input) input.value = ''; return toast(`Corrija as linhas inválidas: ${errors.slice(0, 4).join('; ')}${errors.length > 4 ? '; …' : ''}. Nada foi importado.`, 'error') }
    if (!booksToImport.length) { if (input) input.value = ''; return toast(skipped.length ? `Nenhum livro novo. ${skipped.length} código(s) já existiam no acervo.` : 'Nenhum livro válido para importar.', 'error') }
    pendingCsvImport = { books: booksToImport, counters: countersToUpdate, categories: [...categoriesToCreate.values()], skippedCount: skipped.length }
    if ($('#importCsvSummary')) $('#importCsvSummary').textContent = `Importar ${booksToImport.length} livro(s) e criar ${categoriesToCreate.size} categoria(s) ausentes? O arquivo será vinculado à escola atual. Códigos existentes serão ignorados.`
    modal('importCsvConfirmModal', true)
  } catch (err) {
    error(err, 'Não foi possível ler ou validar o CSV.')
  } finally {
    if (input) input.value = ''
  }
}

async function confirmCsvImport() {
  const pending = pendingCsvImport
  if (!pending || !state.user || !db) return
  const button = $('#confirmCsvImportBtn')
  loading(button, true, 'Importando…')

  try {
    for (const category of pending.categories || []) {
      await setDoc(doc(db, 'categories', `${encodeURIComponent(config.currentSchoolId)}__${category.code}`), {
        ...category,
        schoolId: config.currentSchoolId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true })
    }

    for (const [prefix, importedLastCode] of pending.counters) {
      const counterRef = doc(db, 'counters', `${encodeURIComponent(config.currentSchoolId)}_books_${prefix}`)
      await runTransaction(db, async (transaction) => {
        const counter = await transaction.get(counterRef)
        const lastCode = Number(counter.exists() ? counter.data().lastCode || 0 : 0)
        if (importedLastCode > lastCode) transaction.set(counterRef, { prefix, schoolId: config.currentSchoolId, lastCode: importedLastCode, updatedAt: serverTimestamp() }, { merge: true })
      })
    }

    for (let offset = 0; offset < pending.books.length; offset += 450) {
      const batch = writeBatch(db)
      pending.books.slice(offset, offset + 450).forEach((book) => {
        const { documentId, ...bookData } = book
        const bookRef = documentId ? doc(db, 'books', documentId) : doc(collection(db, 'books'))
        batch.set(bookRef, { ...bookData, createdAt: bookData.createdAt || serverTimestamp(), updatedAt: bookData.updatedAt || serverTimestamp() })
      })
      await batch.commit()
    }

    await logAudit('books_imported', { count: pending.books.length }, state.user.uid)
    toast(`${pending.books.length} livro(s) importado(s). ${pending.skippedCount} código(s) já existente(s) ignorado(s).`)
    pendingCsvImport = null
    modal('importCsvConfirmModal', false)
  } catch (err) {
    error(err, 'Não foi possível importar o CSV.')
  } finally {
    loading(button, false)
  }
}

/* -------------------------
   Subscriptions (admin-only)
   ------------------------- */
function clearAdminSubscriptions() { while (state.adminUnsubs.length) try { state.adminUnsubs.pop()() } catch (e) { console.warn('erro ao limpar subscription:', e) } }

function resetAdminState() {
  clearAdminSubscriptions()
  selectedLabelQuantities.clear()
  schoolSetupRequired = false
  state.user = null
  state.profile = null
  state.readers = []
  state.loans = []
  state.books = []
  state.categories = []
  if ($('#librisAdminView')) $('#librisAdminView').hidden = true
  if ($('#adminView')) $('#adminView').hidden = true
  if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = true
  if ($('#logoutBtn')) $('#logoutBtn').hidden = true
  if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configurações da escola'
  modal('settingsModal', false)
  renderReaders()
  renderLoans()
  renderBooks()
  renderCategoryList()
  renderDashboard()
}

  function selectedLabelBooks() {
    return state.books.filter((book) => selectedLabelQuantities.has(book.id))
  }

  function selectedLabelEntries() {
    return selectedLabelBooks().map((book) => ({
      book,
      quantity: selectedLabelQuantities.get(book.id)
    }))
  }

  function selectedLabelCopyCount() {
    return selectedLabelBooks().reduce((total, book) => total + selectedLabelQuantities.get(book.id), 0)
  }

  function drawWrappedLabelText(context, text, x, y, maxWidth, lineHeight, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean)
    const lines = []
    let line = ''

    words.forEach((word) => {
      const candidate = line ? `${line} ${word}` : word
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    })
    if (line) lines.push(line)

    const visibleLines = lines.slice(0, maxLines)
    if (lines.length > maxLines && visibleLines.length) {
      let lastLine = visibleLines[visibleLines.length - 1]
      while (lastLine && context.measureText(`${lastLine}...`).width > maxWidth) lastLine = lastLine.slice(0, -1)
      visibleLines[visibleLines.length - 1] = `${lastLine.trimEnd()}...`
    }
    visibleLines.forEach((visibleLine, index) => context.fillText(visibleLine, x, y + index * lineHeight))
    return visibleLines.length
  }

  async function createBookLabelCanvas(book) {
    const canvas = document.createElement('canvas')
    canvas.width = 1104
    canvas.height = 600

    const context = canvas.getContext('2d')
    if (!context) throw new Error('Não foi possível preparar a etiqueta.')

    const code = String(book.code || '').trim().toUpperCase()
    if (!/^[\x20-\x7E]+$/.test(code)) {
      throw new Error('O código do acervo precisa conter apenas caracteres ASCII para gerar o Code 128.')
    }

    const { default: JsBarcode } = await import('jsbarcode')
    const barcodeCanvas = document.createElement('canvas')
    JsBarcode(barcodeCanvas, code, {
      format: 'CODE128',
      width: 4,
      height: 100,
      displayValue: false,
      margin: 4,
      lineColor: '#111111',
      background: '#ffffff'
    })

    context.fillStyle = '#fffdf6'
    context.fillRect(0, 0, canvas.width, canvas.height)

    const centerX = canvas.width / 2
    const sideMargin = 58
    const contentWidth = canvas.width - sideMargin * 2
    context.strokeStyle = '#1e5b3d'
    context.lineWidth = 4
    context.strokeRect(12, 12, canvas.width - 24, canvas.height - 24)

    const drawCordelSun = (x, y, scaleX = 1) => {
      context.save()
      context.translate(x, y)
      context.scale(scaleX, 1)
      context.globalAlpha = 0.9
      context.lineWidth = 3.5
      context.lineCap = 'square'
      context.beginPath()
      context.arc(20, 20, 8, 0, Math.PI * 2)
      context.strokeStyle = '#1a241d'
      context.stroke()

      context.beginPath()
      context.arc(20, 20, 4, 0, Math.PI * 2)
      context.strokeStyle = '#1e5b3d'
      context.stroke()

      context.strokeStyle = '#1a241d'
      context.lineWidth = 3
      context.beginPath()
      ;[
        [20, 2, 20, 0],
        [20, 40, 20, 38],
        [2, 20, 0, 20],
        [40, 20, 38, 20],
        [7, 7, 4, 4],
        [33, 7, 36, 4],
        [7, 33, 4, 36],
        [33, 33, 36, 36]
      ].forEach(([x1, y1, x2, y2]) => {
        context.moveTo(x1, y1)
        context.lineTo(x2, y2)
      })
      context.stroke()
      context.restore()
    }

    const drawMandacaru = (x, y, scaleX = 1) => {
      context.save()
      context.translate(x, y)
      context.scale(scaleX * 1.1, 1.1)
      context.globalAlpha = 0.92
      context.lineWidth = 4
      context.lineCap = 'square'
      context.lineJoin = 'miter'
      context.strokeStyle = '#1a241d'
      context.beginPath()
      context.moveTo(20, 58)
      context.lineTo(20, 18)
      context.lineTo(15, 13)
      context.lineTo(15, 5)
      context.moveTo(20, 35)
      context.lineTo(11, 30)
      context.lineTo(8, 24)
      context.lineTo(8, 17)
      context.moveTo(11, 30)
      context.lineTo(5, 33)
      context.lineTo(2, 30)
      context.moveTo(20, 43)
      context.lineTo(29, 38)
      context.lineTo(32, 32)
      context.lineTo(32, 25)
      context.moveTo(29, 38)
      context.lineTo(35, 41)
      context.lineTo(38, 38)
      context.moveTo(12, 58)
      context.lineTo(28, 58)
      context.stroke()

      context.strokeStyle = '#1e5b3d'
      context.lineWidth = 2
      context.beginPath()
      ;[
        [18, 22, 15, 19],
        [22, 28, 25, 25],
        [17, 39, 14, 36],
        [23, 48, 26, 45],
        [9, 24, 6, 22],
        [33, 33, 36, 30]
      ].forEach(([x1, y1, x2, y2]) => {
        context.moveTo(x1, y1)
        context.lineTo(x2, y2)
      })
      context.stroke()
      context.restore()
    }

    drawCordelSun(30, 126)
    drawCordelSun(canvas.width - 30, 126, -1)
    drawMandacaru(30, 286)
    drawMandacaru(canvas.width - 30, 286, -1)

    context.font = '700 38px Arial, sans-serif'
    const badgeWidth = Math.min(420, contentWidth, context.measureText(code).width + 40)
    const badgeX = canvas.width - sideMargin - badgeWidth
    const headerWidth = Math.max(0, badgeX - sideMargin - 24)

    context.textAlign = 'left'
    context.fillStyle = '#1e5b3d'
    context.font = '700 32px Georgia, serif'
    context.fillText('LIBRIS', sideMargin, 42, headerWidth)

    context.fillStyle = '#52645a'
    context.font = '600 21px Arial, sans-serif'
    context.fillText(
      String(config.schoolName || 'Biblioteca escolar').toLocaleUpperCase('pt-BR'),
      sideMargin,
      76,
      headerWidth
    )

    context.beginPath()
    context.moveTo(sideMargin, 98)
    context.lineTo(canvas.width - sideMargin, 98)
    context.strokeStyle = '#d9e0db'
    context.lineWidth = 2
    context.stroke()

    context.fillStyle = '#1a241d'
    context.fillRect(badgeX, 17, badgeWidth, 56)

    context.fillStyle = '#ffffff'
    context.textAlign = 'center'
    context.font = '700 38px Arial, sans-serif'
    context.fillText(code, badgeX + badgeWidth / 2, 57, badgeWidth - 20)

    context.textAlign = 'center'
    context.fillStyle = '#1a241d'
    context.font = '700 68px Georgia, serif'
    const titleY = 155
    const titleLineHeight = 72
    const titleLineCount = drawWrappedLabelText(
      context,
      book.title || 'Livro sem título',
      centerX,
      titleY,
      contentWidth,
      titleLineHeight,
      2
    )

    context.fillStyle = '#1e5b3d'
    context.font = '700 48px Arial, sans-serif'
    const categoryY = titleY + (titleLineCount - 1) * titleLineHeight + 52
    context.fillText(
      String(book.categoryName || label(book.categoryId) || 'Geral').toLocaleUpperCase('pt-BR'),
      centerX,
      categoryY,
      contentWidth
    )

    context.fillStyle = '#4f6256'
    context.font = 'italic 500 46px Arial, sans-serif'
    const authorY = categoryY + 62
    const authorLineHeight = 50
    const authorLineCount = drawWrappedLabelText(
      context,
      book.author || 'Autoria não informada',
      centerX,
      authorY,
      contentWidth,
      authorLineHeight,
      2
    )

    context.fillStyle = '#24352b'
    context.font = '700 39px Arial, sans-serif'
    const lastAuthorY = authorY + (authorLineCount - 1) * authorLineHeight
    const detailsY = Math.max(328, lastAuthorY + 58)
    const detailsSideInset = 28
    context.textAlign = 'left'
    context.fillText(
      `TOMB.: ${String(book.legacyCatalogReference || book.tombamento || '—')}`,
      sideMargin + detailsSideInset,
      detailsY,
      contentWidth / 2 - detailsSideInset
    )

    context.font = '500 34px Arial, sans-serif'
    context.textAlign = 'right'
    context.fillText(
      `ISBN: ${String(book.isbn || '—')}`,
      canvas.width - sideMargin - detailsSideInset,
      detailsY,
      contentWidth / 2 - detailsSideInset
    )

    context.textAlign = 'center'
    const barcodeY = detailsY + 32
    const barcodeScale = Math.min(
      2.4,
      contentWidth / barcodeCanvas.width,
      Math.max(0, canvas.height - 26 - barcodeY) / barcodeCanvas.height
    )
    const barcodeWidth = barcodeCanvas.width * barcodeScale
    const barcodeHeight = barcodeCanvas.height * barcodeScale
    context.drawImage(
      barcodeCanvas,
      centerX - barcodeWidth / 2,
      barcodeY,
      barcodeWidth,
      barcodeHeight
    )

    return canvas
  }

  let labelPreviewRequest = 0

  function renderLabelBookList() {
    const list = $('#labelBookList')
    if (!list) return
    const queryText = ($('#labelBookSearchInput')?.value || '').trim().toLocaleLowerCase('pt-BR')
    const books = state.books.filter((book) => !queryText || [book.title, book.author, book.code].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText)))

    list.innerHTML = books.length ? books.map((book) => {
      const quantity = selectedLabelQuantities.get(book.id) || 1
      const selected = selectedLabelQuantities.has(book.id)
      return `
        <div class="label-book-option">
          <input type="checkbox" data-label-book="${esc(book.id)}" aria-label="Selecionar ${esc(book.title || 'livro sem título')}" ${selected ? 'checked' : ''} />
          <span><strong>${esc(book.title || 'Livro sem título')}</strong><small>${esc(book.code || 'Sem código')} · ${esc(book.author || 'Autoria não informada')}</small></span>
          <label class="label-book-quantity">
            <span>Qtd.</span>
            <input type="number" min="1" value="${quantity}" data-label-quantity="${esc(book.id)}" aria-label="Quantidade de etiquetas para ${esc(book.title || 'livro sem título')}" ${selected ? '' : 'disabled'} />
          </label>
        </div>
      `
    }).join('') : '<p class="label-book-empty">Nenhum livro encontrado nesta escola.</p>'
  }

  async function updateLabelPreview() {
    const books = selectedLabelBooks()
    const empty = $('#labelPreviewEmpty')
    const canvas = $('#labelPreviewCanvas')
    const caption = $('#labelPreviewCaption')
    const count = $('#labelSelectionCount')
    const jpgButton = $('#downloadLabelsJpgBtn')
    const pdfButton = $('#downloadLabelsPdfBtn')
    const requestId = ++labelPreviewRequest

    const copyCount = selectedLabelCopyCount()
    if (count) count.textContent = `${copyCount} etiqueta${copyCount === 1 ? '' : 's'} · ${books.length} livro${books.length === 1 ? '' : 's'}`
    if (jpgButton) {
      jpgButton.disabled = copyCount === 0 || copyCount > 10
      jpgButton.title = copyCount > 10 ? 'A folha A4 JPG comporta até 10 etiquetas. Reduza as quantidades ou use PDF.' : ''
    }
    if (pdfButton) pdfButton.disabled = copyCount === 0

    if (!books.length) {
      if (empty) empty.hidden = false
      if (canvas) canvas.hidden = true
      if (caption) caption.hidden = true
      return
    }

    if (empty) empty.hidden = true
    if (canvas) canvas.hidden = false
    if (caption) caption.hidden = false
    if (caption) caption.textContent = 'Gerando a prévia em alta resolução…'

    try {
      const labelCanvas = await createBookLabelCanvas(books[0])
      if (requestId !== labelPreviewRequest || !canvas) return
      const context = canvas.getContext('2d')
      context?.clearRect(0, 0, canvas.width, canvas.height)
      context?.drawImage(labelCanvas, 0, 0, canvas.width, canvas.height)
      if (caption) caption.textContent = copyCount > 1
        ? `Prévia de ${books[0].title || 'livro selecionado'}. Serão geradas ${copyCount} etiquetas.`
        : 'Etiqueta no formato pronto para impressão.'
    } catch (err) {
      console.error('Falha ao gerar prévia QR:', err)
      if (caption) caption.textContent = 'Não foi possível gerar o QR. Confira sua conexão e tente novamente.'
    }
  }

  function renderLabelSelection() {
    renderLabelBookList()
    updateLabelPreview()
  }

  async function downloadLabelSheetJpg() {
    const entries = selectedLabelEntries()
    const copyCount = selectedLabelCopyCount()
    if (!copyCount || copyCount > 10) return
    const button = $('#downloadLabelsJpgBtn')
    const filename = `etiquetas-${String(config.currentSchoolId).replace(/[^a-z0-9_-]/gi, '_')}.jpg`
    loading(button, true, 'Gerando JPG…')
    try {
      const target = await chooseSaveTarget(filename, 'Imagem JPG', ['jpg'])
      if (!target) return
      const labels = []
      for (const { book, quantity } of entries) {
        const labelCanvas = await createBookLabelCanvas(book)
        for (let copy = 0; copy < quantity; copy += 1) labels.push(labelCanvas)
      }
      const columns = 2
      const dpi = 300
      const pxPerMm = dpi / 25.4
      const cardWidth = Math.round(90 * pxPerMm)
      const cardHeight = Math.round(cardWidth * 600 / 1104)
      const columnGap = Math.round(10 * pxPerMm)
      const rowGap = Math.round(5 * pxPerMm)
      const leftMargin = Math.round(10 * pxPerMm)
      const topMargin = Math.round(14 * pxPerMm)
      const sheet = document.createElement('canvas')
      sheet.width = 2480
      sheet.height = 3508
      const context = sheet.getContext('2d')
      if (!context) throw new Error('Não foi possível preparar a folha JPG.')
      context.fillStyle = '#f1f4f1'
      context.fillRect(0, 0, sheet.width, sheet.height)
      labels.forEach((labelCanvas, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        const x = leftMargin + column * (cardWidth + columnGap)
        const y = topMargin + row * (cardHeight + rowGap)
        context.drawImage(labelCanvas, x, y, cardWidth, cardHeight)
      })
      await saveBlobToTarget(await canvasToBlob(sheet), target)
    } catch (err) {
      console.error('Falha ao gerar etiquetas JPG:', err)
      toast('Não foi possível gerar o JPG. Tente novamente.', 'error')
    } finally {
      loading(button, false)
    }
  }

  async function downloadLabelSheetPdf() {
    const entries = selectedLabelEntries()
    if (!selectedLabelCopyCount()) return
    const button = $('#downloadLabelsPdfBtn')
    const filename = `etiquetas-${String(config.currentSchoolId).replace(/[^a-z0-9_-]/gi, '_')}.pdf`
    loading(button, true, 'Gerando PDF…')
    try {
      const target = await chooseSaveTarget(filename, 'Documento PDF', ['pdf'])
      if (!target) return
      const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
      const cardWidth = 90
      const cardHeight = cardWidth * 600 / 1104
      const columnGap = 10
      const rowGap = 5
      const leftMargin = 10
      const topMargin = 14

      let index = 0
      for (const { book, quantity } of entries) {
        const labelCanvas = await createBookLabelCanvas(book)
        const image = labelCanvas.toDataURL('image/jpeg', 0.95)
        for (let copy = 0; copy < quantity; copy += 1) {
          if (index > 0 && index % 10 === 0) pdf.addPage()
          const position = index % 10
          const column = position % 2
          const row = Math.floor(position / 2)
          const x = leftMargin + column * (cardWidth + columnGap)
          const y = topMargin + row * (cardHeight + rowGap)
          pdf.addImage(image, 'JPEG', x, y, cardWidth, cardHeight, undefined, 'FAST')
          index += 1
        }
      }

      pdf.setProperties({ title: `Etiquetas de ${config.schoolName}`, subject: `Acervo ${config.currentSchoolId}`, author: 'Libris' })
      await saveBlobToTarget(pdf.output('blob'), target)
    } catch (err) {
      console.error('Falha ao gerar etiquetas PDF:', err)
      toast('Não foi possível gerar o PDF. Tente novamente.', 'error')
    } finally {
      loading(button, false)
    }
  }

function watchAdminCollection(name, schoolId, onData) {
  return new Promise((resolve, reject) => {
    let waitingForFirstSnapshot = true
    const unsubscribe = onSnapshot(
      query(collection(db, name), where('schoolId', '==', schoolId)),
      (snap) => {
        onData(snap)
        if (waitingForFirstSnapshot) {
          waitingForFirstSnapshot = false
          resolve()
        }
      },
      (err) => {
        if (waitingForFirstSnapshot) {
          waitingForFirstSnapshot = false
          reject(err)
        } else {
          error(err)
        }
      }
    )
    state.adminUnsubs.push(unsubscribe)
  })
}

async function subscribeAdmin() {
  if (!db) return
  clearAdminSubscriptions()
  const activeSchoolId = config.currentSchoolId

  await Promise.all([
    watchAdminCollection('books', activeSchoolId, (snap) => {
      state.books = snap.docs.map((d) => {
        const data = d.data()
        const total = Number(data.total || 0)
        const available = Number(data.available ?? total)
        return { id: d.id, ...data, total, available, status: available > 0 ? 'disponivel' : 'emprestado' }
      })
      renderBooks(); renderDashboard()
      updateLoanQuantityLimit(state.readers.find((reader) => reader.id === $('#loanReaderIdInput')?.value))
    }),
    watchAdminCollection('categories', activeSchoolId, (snap) => {
      state.categories = snap.docs.map((d) => ({ ...d.data(), id: d.data().id || d.id, docId: d.id }))
      renderCategorySelect(); renderCategoryList(); renderBooks(); renderDashboard()
    }),
    watchAdminCollection('readers', activeSchoolId, (snap) => {
      state.readers = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      renderReaders(); renderDashboard()
    }),
    watchAdminCollection('loans', activeSchoolId, (snap) => {
      state.loans = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      renderLoans(); renderDashboard()
      updateLoanQuantityLimit(state.readers.find((reader) => reader.id === $('#loanReaderIdInput')?.value))
    })
  ])
}

/* -------------------------
   Forms / modals helpers
   ------------------------- */
function resetBookForm() { 
  const form = $('#bookForm')
  if (form) form.reset()
  if ($('#bookIdInput')) $('#bookIdInput').value = ''
  const titleHeader = $('#bookModalTitle')
  if (titleHeader) titleHeader.textContent = 'Cadastrar livro'
  if ($('#saveBookBtn')) $('#saveBookBtn').textContent = 'Salvar livro'
  renderCategorySelect()
  if ($('#bookYearInput')) $('#bookYearInput').value = new Date().getFullYear()
  if ($('#bookQuantityInput')) $('#bookQuantityInput').value = 1
}

function resetReaderForm() { 
  const form = $('#readerForm')
  if (form) form.reset()
  if ($('#readerIdInput')) $('#readerIdInput').value = ''
  const titleHeader = $('#readerModalTitle')
  if (titleHeader) titleHeader.textContent = 'Cadastrar leitor'
  if ($('#saveReaderBtn')) $('#saveReaderBtn').textContent = 'Salvar leitor'
  updateReaderFields()
}

function editBook(id) { 
  const book = state.books.find((item) => item.id === id)
  if (!book) return
  if ($('#bookIdInput')) $('#bookIdInput').value = id
  if ($('#bookTitleInput')) $('#bookTitleInput').value = book.title || ''
  if ($('#bookAuthorInput')) $('#bookAuthorInput').value = book.author || ''
  if ($('#bookPublisherInput')) $('#bookPublisherInput').value = book.publisher || ''
  if ($('#bookCategoryInput')) $('#bookCategoryInput').value = book.categoryId || ''
  if ($('#bookYearInput')) $('#bookYearInput').value = book.year || ''
  if ($('#bookShelfInput')) $('#bookShelfInput').value = book.shelf || ''
  if ($('#bookQuantityInput')) $('#bookQuantityInput').value = Number(book.total || 1)
  if ($('#bookIsbnInput')) $('#bookIsbnInput').value = book.isbn || ''
  if ($('#bookTombamentoInput')) $('#bookTombamentoInput').value = book.legacyCatalogReference || book.tombamento || ''
  
  const titleHeader = $('#bookModalTitle')
  if (titleHeader) titleHeader.textContent = 'Editar livro'
  if ($('#saveBookBtn')) $('#saveBookBtn').textContent = 'Atualizar livro'
  modal('bookFormModal', true)
}

function editReader(id) { 
  const reader = state.readers.find((item) => item.id === id)
  if (!reader) return
  if ($('#readerIdInput')) $('#readerIdInput').value = id
  if ($('#readerNameInput')) $('#readerNameInput').value = reader.name || ''
  if ($('#readerTypeInput')) $('#readerTypeInput').value = reader.type || 'Aluno'
  if ($('#readerCourseInput')) $('#readerCourseInput').value = reader.course || ''
  if ($('#readerRegistrationInput')) $('#readerRegistrationInput').value = reader.matricula || ''
  if ($('#readerCpfInput')) $('#readerCpfInput').value = reader.cpf || ''
  if ($('#readerEmailInput')) $('#readerEmailInput').value = reader.email || ''
  if ($('#readerPhoneInput')) $('#readerPhoneInput').value = reader.phone || ''
  
  const titleHeader = $('#readerModalTitle')
  if (titleHeader) titleHeader.textContent = 'Editar leitor'
  if ($('#saveReaderBtn')) $('#saveReaderBtn').textContent = 'Atualizar leitor'
  updateReaderFields()
  modal('readerFormModal', true)
}

function updateReaderFields() { 
  const typeSelect = $('#readerTypeInput')
  if (!typeSelect) return
  const student = typeSelect.value === 'Aluno'
  ;[['#readerCourseField', student], ['#readerRegistrationField', student], ['#readerCpfField', !student]].forEach(([s, visible]) => {
    const f = $(s)
    if (f) {
      f.hidden = !visible
      f.classList.toggle('hidden', !visible)
    }
  })
  if ($('#readerCourseInput')) $('#readerCourseInput').required = student
  if ($('#readerRegistrationInput')) $('#readerRegistrationInput').required = student
  if ($('#readerCpfInput')) $('#readerCpfInput').required = !student
}

/* Loans rendering */
function renderLoans() {
  const tbody = $('#loansTableBody')
  if (!tbody) return
  const queryText = state.loanQuery.trim().toLocaleLowerCase('pt-BR')

  const list = state.loans.filter((l) => {
    if (l.status !== 'active') return false

    const reader = state.readers.find((r) => r.id === l.readerId)
    const role = String(reader?.role || reader?.type || '').toLowerCase()
    const matchesFilter = state.loanFilter === 'student'
      ? role === 'student' || role === 'aluno'
      : state.loanFilter === 'teacher'
        ? role === 'teacher' || role === 'professor'
        : state.loanFilter === 'other'
          ? !isStudentReader(reader) && role !== 'teacher' && role !== 'professor'
          : state.loanFilter === 'overdue'
            ? overdue(l)
            : true
    if (!matchesFilter) return false

    const searchFields = [
      l.bookTitle,
      l.bookCode,
      l.readerName,
      reader?.name,
      reader?.email,
      reader?.phone,
      reader?.matricula,
      reader?.course,
      reader?.class
    ]
    return !queryText || searchFields.some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText))
  }).sort((left, right) => {
    const daysLate = (loan) => overdue(loan) ? Math.ceil((Date.now() - date(getLoanDueDate(loan)).getTime()) / 86400000) : 0
    const studentPriority = (loan) => {
      const reader = state.readers.find((item) => item.id === loan.readerId)
      return isStudentReader(reader) && overdue(loan) ? 1 : 0
    }
    return studentPriority(right) - studentPriority(left) || daysLate(right) - daysLate(left)
  })

  tbody.innerHTML = list.length ? list.map((l) => {
    const selectedDays = Number(l.days || 7)
    const reader = state.readers.find((item) => item.id === l.readerId)
    const maximum = getMaxLoanDaysForReader(reader)
    const renewalDays = Math.max(1, maximum === null ? selectedDays : Math.min(selectedDays, maximum))
    const maximumAttribute = maximum === null ? '' : `max="${maximum}"`
    const renewalLabel = maximum === null ? 'Dias para renovar' : `Dias para renovar (máximo ${maximum})`
    const copyCount = loanQuantity(l)
    return `<tr><td><strong>${esc(l.bookTitle)}</strong><div class="loan-book-details"><small>${esc(l.bookCode)}</small><small>Quantidade: ${copyCount} ${copyCount === 1 ? 'exemplar' : 'exemplares'}</small></div></td><td>${esc(l.readerName)}</td><td><div class="loan-dates"><span>Empréstimo: ${formatDate(l.createdAt)}</span><span>Vencimento: ${formatDate(getLoanDueDate(l))}</span></div><small>Prazo: ${selectedDays} dias</small></td><td><span class="badge ${overdue(l) ? 'borrowed' : 'available'}">${overdue(l) ? 'Em atraso' : 'Em dia'}</span></td><td><div class="action-row"><input class="renew-days" type="number" min="1" ${maximumAttribute} value="${renewalDays}" data-renew-days="${esc(l.id)}" aria-label="${renewalLabel}"><button class="small-btn primary" data-return="${esc(l.id)}" type="button">Devolver</button><button class="small-btn warning" data-renew="${esc(l.id)}" type="button">Renovar</button><button class="small-btn danger" data-notify="${esc(l.id)}" type="button">Notificar</button><button class="small-btn secondary" data-edit-loan="${esc(l.id)}" type="button">Editar</button></div></td></tr>`
  }).join('') : '<tr><td colspan="5" class="text-center">Nenhum empréstimo corresponde à busca e aos filtros.</td></tr>'

  $$('[data-edit-loan]').forEach((button) => {
    button.onclick = () => openEditLoanModal(button.dataset.editLoan)
  })
  $$('[data-return]').forEach((b) => b.onclick = () => returnLoan(b.dataset.return))
  $$('[data-renew]').forEach((b) => b.onclick = () => renewLoan(b.dataset.renew))
  $$('[data-notify]').forEach((b) => b.onclick = () => notify(b.dataset.notify))

  const filterSelect = $('#loanFilterSelect')
  if (filterSelect) {
    filterSelect.value = state.loanFilter || 'all'
    filterSelect.onchange = (evt) => {
      state.loanFilter = evt.target.value
      renderLoans()
    }
  }
}

async function openEditLoanModal(loanId) {
  const cachedLoan = state.loans.find((item) => item.id === loanId && item.status === 'active')
  const form = $('#loanEditForm')
  const reader = state.readers.find((item) => item.id === cachedLoan?.readerId)
  if (!cachedLoan || !form || !reader) {
    toast('Não foi possível abrir este empréstimo para edição.', 'error')
    return
  }

  try {
    const [activeLoansSnap, bookSnap] = await Promise.all([
      getDocs(query(
        collection(db, 'loans'),
        where('schoolId', '==', config.currentSchoolId),
        where('readerId', '==', reader.id),
        where('status', '==', 'active')
      )),
      getDoc(doc(db, 'books', cachedLoan.bookId))
    ])
    const activeLoans = activeLoansSnap.docs.map((loanDoc) => ({ id: loanDoc.id, ...loanDoc.data() }))
    const loan = activeLoans.find((item) => item.id === loanId)
    if (!loan || !bookSnap.exists()) {
      toast('Este empréstimo ou livro não está mais ativo nesta escola.', 'error')
      return
    }

    const currentQuantity = loanQuantity(loan)
    const loanLimit = getLoanLimitForReader(reader)
    const bookData = bookSnap.data()
    if (bookData.schoolId && bookData.schoolId !== config.currentSchoolId) {
      toast('Este empréstimo ou livro não está mais ativo nesta escola.', 'error')
      return
    }
    const availableCopies = Number(bookData.available ?? bookData.total ?? 0)
    const quantityLimit = getLoanQuantityLimit({
      loanLimit,
      activeLoans,
      readerId: reader.id,
      availableCopies,
      currentLoanId: loan.id,
      currentLoanQuantity: currentQuantity
    })

    form.dataset.loanId = loan.id
    $('#loanStartAtInput').value = dateTimeLocalValue(loan.createdAt)
    $('#loanDueAtInput').value = dateTimeLocalValue(getLoanDueDate(loan))
    const quantityInput = $('#loanEditQuantityInput')
    quantityInput.value = String(quantityLimit.maximum > 0
      ? Math.min(currentQuantity, quantityLimit.maximum)
      : currentQuantity)
    quantityInput.dataset.max = String(quantityLimit.maximum)
    quantityInput.removeAttribute('max')
    const limitSummary = `Limite total: ${quantityLimit.loanLimit}; outros empréstimos usam ${quantityLimit.otherActiveCopies}; restam ${quantityLimit.remainingReaderCopies}. Há ${availableCopies} exemplares disponíveis. Máximo seguro nesta edição: ${quantityLimit.maximum}.`
    $('#loanEditQuantityHelp').textContent = currentQuantity > quantityLimit.maximum
      ? `A quantidade atual (${currentQuantity}) excede o máximo seguro. Reduza-a para salvar. ${limitSummary}`
      : limitSummary
    modal('loanEditModal', true)
  } catch (err) {
    error(err, 'Não foi possível consultar os empréstimos atuais e o estoque deste livro.')
  }
}

let loanEditPending = false

async function saveEditedLoan(event) {
  event.preventDefault()
  if (loanEditPending) return

  const form = $('#loanEditForm')
  const button = $('#saveLoanEditBtn')
  const loanId = form?.dataset.loanId
  const loan = state.loans.find((item) => item.id === loanId && item.status === 'active')
  const reader = state.readers.find((item) => item.id === loan?.readerId)
  const startAt = loan ? date(loan.createdAt) : null
  const dueAt = new Date($('#loanDueAtInput')?.value || '')
  const quantity = Number($('#loanEditQuantityInput')?.value)
  if (!loan || !reader) {
    toast('Este empréstimo não está mais ativo.', 'error')
    modal('loanEditModal', false)
    return
  }
  if (
    !(startAt instanceof Date) ||
    Number.isNaN(startAt.getTime()) ||
    Number.isNaN(dueAt.getTime()) ||
    dueAt <= startAt ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  ) {
    return toast('Confira as datas e informe uma quantidade inteira maior que zero.', 'error')
  }

  loanEditPending = true
  loading(button, true, 'Salvando…')
  try {
    const activeLoansSnap = await getDocs(query(
      collection(db, 'loans'),
      where('schoolId', '==', config.currentSchoolId),
      where('readerId', '==', reader.id),
      where('status', '==', 'active')
    ))
    const loanLimit = getLoanLimitForReader(reader)
    const activeLoans = activeLoansSnap.docs.map((loanDoc) => ({ id: loanDoc.id, ...loanDoc.data() }))
    const currentLoan = activeLoans.find((item) => item.id === loanId)
    const book = state.books.find((item) => item.id === loan.bookId)
    if (!currentLoan || !book) {
      return toast('Não foi possível validar o estoque e os empréstimos ativos.', 'error')
    }
    const quantityLimit = getLoanQuantityLimit({
      loanLimit,
      activeLoans,
      readerId: reader.id,
      availableCopies: Number(book.available ?? 0),
      currentLoanId: loanId,
      currentLoanQuantity: loanQuantity(currentLoan)
    })
    if (quantity > quantityLimit.maximum) {
      return toast(`Máximo permitido: ${quantityLimit.maximum} exemplar(es). Limite do leitor: ${quantityLimit.loanLimit}; outros empréstimos: ${quantityLimit.otherActiveCopies}; disponíveis deste título: ${quantityLimit.availableCopies}.`, 'error')
    }

    const startDay = Date.UTC(startAt.getFullYear(), startAt.getMonth(), startAt.getDate())
    const dueDay = Date.UTC(dueAt.getFullYear(), dueAt.getMonth(), dueAt.getDate())
    const days = Math.max(1, Math.round((dueDay - startDay) / 86400000))
    await runTransaction(db, async (tx) => {
      const loanRef = doc(db, 'loans', loanId)
      const loanSnap = await tx.get(loanRef)
      if (!loanSnap.exists() || loanSnap.data().status !== 'active' || loanSnap.data().schoolId !== config.currentSchoolId) {
        throw new Error('empréstimo inválido')
      }

      const currentLoan = loanSnap.data()
      const bookRef = doc(db, 'books', currentLoan.bookId)
      const bookSnap = await tx.get(bookRef)
      if (!bookSnap.exists()) throw new Error('livro inválido')
      const bookData = bookSnap.data()
      if (bookData.schoolId && bookData.schoolId !== config.currentSchoolId) throw new Error('livro inválido')

      const previousQuantity = loanQuantity(currentLoan)
      const delta = quantity - previousQuantity
      const availableCopies = Number(bookData.available || 0)
      if (delta > availableCopies) throw new Error('estoque insuficiente')

      if (delta !== 0) {
        const totalCopies = Number(bookData.total || 0)
        const updatedAvailable = Math.max(0, Math.min(totalCopies, availableCopies - delta))
        tx.update(bookRef, {
          available: updatedAvailable,
          status: updatedAvailable > 0 ? 'disponivel' : 'emprestado',
          schoolId: bookData.schoolId || config.currentSchoolId,
          updatedAt: serverTimestamp()
        })
      }

      tx.update(loanRef, {
        dueDate: Timestamp.fromDate(dueAt),
        dueAt: Timestamp.fromDate(dueAt),
        days,
        quantity,
        notices: {},
        schoolId: config.currentSchoolId,
        updatedAt: serverTimestamp()
      })
    })

    await logAudit('loan_updated', { loanId, dueAt, quantity }, state.user?.uid || null)
    modal('loanEditModal', false)
    toast('Empréstimo atualizado.')
  } catch (err) {
    if (err.message === 'estoque insuficiente') {
      toast('Não há exemplares disponíveis suficientes para aumentar esta quantidade.', 'error')
    } else if (err.message === 'empréstimo inválido') {
      toast('Este empréstimo não está mais ativo ou não pertence à escola atual.', 'error')
    } else if (err.message === 'livro inválido') {
      toast('O livro deste empréstimo não está disponível na escola atual.', 'error')
    } else {
      error(err, 'Não foi possível atualizar o empréstimo.')
    }
  } finally {
    loading(button, false)
    loanEditPending = false
  }
}

/* Notification helper used in table actions */
async function notify(id) {
  const loan = state.loans.find((l) => l.id === id)
  const reader = state.readers.find((r) => r.id === loan?.readerId)
  if (!loan) return
  if ($('#notificationContact')) {
    const emailTarget = reader?.email || loan.readerEmail || 'E-mail não informado'
    $('#notificationContact').textContent = `${emailTarget} · ${reader?.phone || 'Telefone não informado'}`
  }
  if ($('#notificationMessage')) $('#notificationMessage').value = `Olá, ${loan.readerName}. O empréstimo de ${loanQuantity(loan)} exemplar(es) do livro "${loan.bookTitle}" vence em ${formatDate(getLoanDueDate(loan))}. Por favor, procure a biblioteca escolar.`
  const modalEl = $('#notificationModal')
  if (modalEl) modalEl.dataset.loanId = String(id)
  modal('notificationModal', true)
  await updateEmailCredentialStatus('notificationEmailStatus')
}

let bookCodeScanTimer = null

function acceptScannedBook(rawValue) {
  const normalizedValue = String(rawValue || '').trim()
  if (!normalizedValue) return false

  const { schoolId: payloadSchoolId, bookId: payloadBookId, code: matchedCode } = parseBookScan(normalizedValue)
  const bookById = payloadBookId
    ? state.books.find((item) => String(item.id) === String(payloadBookId))
    : null
  const bookByCode = state.books.find((item) => String(item.code || '').trim().toUpperCase() === matchedCode)
  const book = bookById || bookByCode
  const scannedSchoolId = String(payloadSchoolId || '').trim().toLocaleLowerCase('pt-BR')
  const currentSchoolId = String(config.currentSchoolId || '').trim().toLocaleLowerCase('pt-BR')

  if (payloadSchoolId && scannedSchoolId !== currentSchoolId) {
    const message = 'Esta etiqueta pertence a outra escola ou está desatualizada. Gere uma nova etiqueta para este acervo.'
    toast(message, 'error')
    return false
  }

  if (!book) {
    const message = matchedCode
      ? `Livro ${matchedCode} não encontrado no acervo desta escola.`
      : 'O leitor não enviou um código reconhecível. Confira a etiqueta e tente novamente.'
    toast(message, 'error')
    return false
  }

  if ($('#bookCodeInput')) $('#bookCodeInput').value = String(book.code || matchedCode).toUpperCase()
  $('#readerInput')?.focus()
  toast(`Livro encontrado: ${book.title}. Selecione o leitor para continuar.`)
  return true
}

function scheduleBookCodeScan(event) {
  clearTimeout(bookCodeScanTimer)
  bookCodeScanTimer = null
  const input = event.currentTarget
  const scannedValue = String(input.value || '').trim()
  if (!isCompleteBookScan(scannedValue)) return

  bookCodeScanTimer = setTimeout(() => {
    bookCodeScanTimer = null
    if (String(input.value || '').trim() === scannedValue) acceptScannedBook(scannedValue)
  }, 140)
}

function handleBookCodeEntry(event) {
  if (event.key !== 'Enter') return

  event.preventDefault()
  clearTimeout(bookCodeScanTimer)
  bookCodeScanTimer = null

  const input = event.currentTarget
  const scannedValue = String(input.value || '').trim()
  if (!scannedValue) return

  if (!acceptScannedBook(scannedValue)) {
    input.select()
  }
}

function focusBookCodeInput() {
  requestAnimationFrame(() => $('#bookCodeInput')?.focus())
}

function setAdminTab(tabName) {
  $$('.tab-btn').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === tabName)
    button.setAttribute('aria-pressed', String(button.dataset.tab === tabName))
    if (button.getAttribute('role') === 'tab') {
      button.setAttribute('aria-selected', String(button.dataset.tab === tabName))
    }
  })
  $$('.tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === tabName)
  })

  const isRootTab = tabName === 'checkout'
  $('#adminView')?.classList.remove('is-subview')
  const backButton = $('#backToLoansBtn')
  if (backButton) backButton.hidden = true
  if (isRootTab) focusBookCodeInput()
}

/* -------------------------
   Form wiring and setup
   ------------------------- */
function setup() {
  // Tabs
  $$('.tab-btn').forEach((b) => b.onclick = () => {
    setAdminTab(b.dataset.tab)
  })

  if ($('#acervoSearchInput')) $('#acervoSearchInput').oninput = (x) => { state.acervoQuery = x.target.value; renderBooks() }
  if ($('#readerSearchInput')) $('#readerSearchInput').oninput = (x) => { state.readerQuery = x.target.value; renderReaders() }
  if ($('#readerFilterSelect')) $('#readerFilterSelect').onchange = (event) => { state.readerFilter = event.target.value; renderReaders() }
  if ($('#loanSearchInput')) $('#loanSearchInput').oninput = (x) => { state.loanQuery = x.target.value; renderLoans() }
  if ($('#bookCodeInput')) $('#bookCodeInput').oninput = () => {
    const reader = state.readers.find((item) => item.id === $('#loanReaderIdInput')?.value)
    updateLoanQuantityLimit(reader)
  }
  if ($('#loanQuantityInput')) $('#loanQuantityInput').oninput = (event) => {
    const input = event.currentTarget
    const maximum = Number(input.max)
    const quantity = Number(input.value)
    if (input.value && Number.isSafeInteger(maximum) && maximum > 0 && Number.isSafeInteger(quantity) && quantity > maximum) {
      input.value = String(maximum)
      const help = $('#loanQuantityHelp')
      if (help) help.textContent = `Quantidade ajustada ao máximo seguro (${maximum}), considerando o limite restante do leitor e os exemplares disponíveis.`
    }
  }
  if ($('#readerInput')) {
    $('#readerInput').oninput = () => {
      if ($('#loanReaderIdInput')) $('#loanReaderIdInput').value = ''
      updateLoanDaysLimit(null, true)
      updateLoanQuantityLimit(null)
      renderReaderSelector()
    }
    $('#readerInput').onkeydown = (event) => {
      if (event.key === 'Enter' && !$('#loanReaderIdInput')?.value) {
        const firstOption = $('[data-select-loan-reader]')
        if (firstOption) {
          event.preventDefault()
          selectLoanReader(firstOption.dataset.selectLoanReader)
        }
      }
      if (event.key === 'Escape' && $('#readerSuggestions')) {
        $('#readerSuggestions').hidden = true
        $('#readerInput').setAttribute('aria-expanded', 'false')
      }
    }
  }
  if ($('#readerSuggestions')) $('#readerSuggestions').onclick = (event) => {
    const option = event.target.closest('[data-select-loan-reader]')
    if (option) selectLoanReader(option.dataset.selectLoanReader)
  }
  if ($('#loanEditQuantityInput')) $('#loanEditQuantityInput').oninput = (event) => {
    const input = event.currentTarget
    const maximum = Number(input.dataset.max)
    const quantity = Number(input.value)
    if (input.value && Number.isSafeInteger(maximum) && maximum > 0 && Number.isSafeInteger(quantity) && quantity > maximum) {
      input.value = String(maximum)
      $('#loanEditQuantityHelp').textContent = `Máximo permitido: ${maximum} ${maximum === 1 ? 'exemplar' : 'exemplares'}. A quantidade foi ajustada ao limite seguro.`
    }
  }

  if ($('#bookForm')) $('#bookForm').onsubmit = addBook
  if ($('#categoryForm')) $('#categoryForm').onsubmit = addCategory
  if ($('#readerForm')) $('#readerForm').onsubmit = addReader
  if ($('#loanEditForm')) $('#loanEditForm').onsubmit = saveEditedLoan
  if ($('#librisConfigForm')) $('#librisConfigForm').onsubmit = saveLibrisConfiguration
  if ($('#removeSmtpPasswordBtn')) $('#removeSmtpPasswordBtn').onclick = removeSmtpPassword
  if ($('#loginForm')) $('#loginForm').onsubmit = handleLocalLogin
  if ($('#credeLoginForm')) $('#credeLoginForm').onsubmit = handleCredeLogin
  if ($('#toggleCredePasswordBtn')) {
    $('#toggleCredePasswordBtn').onclick = () => {
      const input = $('#credePasswordInput')
      const button = $('#toggleCredePasswordBtn')
      if (!input || !button) return

      const showing = input.type === 'password'
      input.type = showing ? 'text' : 'password'
      button.setAttribute('aria-pressed', String(showing))
      button.setAttribute('aria-label', showing ? 'Ocultar senha' : 'Mostrar senha')
    }
  }
  if ($('#toggleLocalPasswordBtn')) {
    $('#toggleLocalPasswordBtn').onclick = () => {
      const input = $('#localLoginPasswordInput')
      const button = $('#toggleLocalPasswordBtn')
      if (!input || !button) return

      const showing = input.type === 'password'
      input.type = showing ? 'text' : 'password'
      button.setAttribute('aria-pressed', String(showing))
      button.setAttribute('aria-label', showing ? 'Ocultar senha' : 'Mostrar senha')
    }
  }
  if ($('#bookCodeInput')) {
    $('#bookCodeInput').onkeydown = handleBookCodeEntry
    $('#bookCodeInput').addEventListener('input', scheduleBookCodeScan)
  }
  if ($('#addLocalAccountBtn')) $('#addLocalAccountBtn').onclick = () => addLocalAccountRow()
  if ($('#openCredeLoginBtn')) $('#openCredeLoginBtn').onclick = () => {
    if ($('#loginForm')) $('#loginForm').hidden = true
    if ($('#credeLoginForm')) $('#credeLoginForm').hidden = false
    $('#credeEmailInput')?.focus()
  }
  if ($('#backToLocalLoginBtn')) $('#backToLocalLoginBtn').onclick = () => {
    if ($('#credeLoginForm')) $('#credeLoginForm').hidden = true
    if ($('#loginForm')) $('#loginForm').hidden = false
  }
  if ($('#schoolSettingsForm')) $('#schoolSettingsForm').onsubmit = saveSchoolSettings
  if ($('#themePreferenceInput')) {
    $('#themePreferenceInput').value = getThemePreference()
    $('#themePreferenceInput').onchange = (event) => applyThemePreference(event.target.value, true)
  }
  if ($('#readerTypeInput')) $('#readerTypeInput').onchange = updateReaderFields
  if ($('#registerLoanBtn')) $('#registerLoanBtn').onclick = registerLoan
  updateLoanDaysLimit(null)
  if ($('#openBookModalBtn')) $('#openBookModalBtn').onclick = () => { resetBookForm(); modal('bookFormModal', true) }
  if ($('#openReaderModalBtn')) $('#openReaderModalBtn').onclick = () => { resetReaderForm(); modal('readerFormModal', true) }
  const openCategoryModal = () => {
    if ($('#categoryForm')) $('#categoryForm').reset()
    modal('categoryModal', true)
  }
  if ($('#openCategoryFromBookBtn')) $('#openCategoryFromBookBtn').onclick = openCategoryModal
  if ($('#openBookLabelsBtn')) $('#openBookLabelsBtn').onclick = () => {
    if ($('#labelBookSearchInput')) $('#labelBookSearchInput').value = ''
    renderLabelSelection()
    modal('bookLabelsModal', true)
  }
  if ($('#labelBookSearchInput')) $('#labelBookSearchInput').oninput = renderLabelBookList
  if ($('#labelBookList')) $('#labelBookList').onchange = (event) => {
    const checkbox = event.target.closest('[data-label-book]')
    if (checkbox) {
      if (checkbox.checked) selectedLabelQuantities.set(checkbox.dataset.labelBook, 1)
      else selectedLabelQuantities.delete(checkbox.dataset.labelBook)
      renderLabelSelection()
      return
    }

    const quantityInput = event.target.closest('[data-label-quantity]')
    if (!quantityInput) return
    const bookId = quantityInput.dataset.labelQuantity
    if (!selectedLabelQuantities.has(bookId)) return
    const quantity = Number(quantityInput.value)
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      toast('Informe uma quantidade inteira de etiquetas maior que zero.', 'error')
      renderLabelBookList()
      return
    }
    selectedLabelQuantities.set(bookId, quantity)
    renderLabelSelection()
  }
  if ($('#selectLabelSearchResultsBtn')) $('#selectLabelSearchResultsBtn').onclick = () => {
    const queryText = ($('#labelBookSearchInput')?.value || '').trim().toLocaleLowerCase('pt-BR')
    state.books.filter((book) => !queryText || [book.title, book.author, book.code].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText))).forEach((book) => {
      if (!selectedLabelQuantities.has(book.id)) selectedLabelQuantities.set(book.id, 1)
    })
    renderLabelSelection()
  }
  if ($('#clearLabelSelectionBtn')) $('#clearLabelSelectionBtn').onclick = () => {
    selectedLabelQuantities.clear()
    renderLabelSelection()
  }
  if ($('#downloadLabelsJpgBtn')) $('#downloadLabelsJpgBtn').onclick = downloadLabelSheetJpg
  if ($('#downloadLabelsPdfBtn')) $('#downloadLabelsPdfBtn').onclick = downloadLabelSheetPdf
  if ($('#downloadDashboardJpgBtn')) $('#downloadDashboardJpgBtn').onclick = downloadDashboardChartsJpg
  if ($('#downloadDashboardPdfBtn')) $('#downloadDashboardPdfBtn').onclick = downloadDashboardChartsPdf
  if ($('#downloadDashboardReportBtn')) $('#downloadDashboardReportBtn').onclick = downloadDashboardReport

  if ($('#cancelBookEditBtn')) $('#cancelBookEditBtn').onclick = () => modal('bookFormModal', false)
  if ($('#cancelReaderEditBtn')) $('#cancelReaderEditBtn').onclick = () => modal('readerFormModal', false)
  if ($('#exportBtn')) $('#exportBtn').onclick = () => modal('exportModal', true)
  if ($('#exportCsvOption')) $('#exportCsvOption').onclick = exportCsv
  if ($('#openSettingsBtn')) $('#openSettingsBtn').onclick = () => {
    syncSchoolSettingsForm()
    if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configurações da escola'
    modal('settingsModal', true)
  }
  if ($('#openAboutBtn')) $('#openAboutBtn').onclick = () => modal('aboutModal', true)
  if ($('#openHelpBtn')) $('#openHelpBtn').onclick = () => modal('helpModal', true)
  $$('.chart-info-btn').forEach((button) => {
    button.onclick = () => {
      const title = $('#chartInfoTitle')
      const description = $('#chartInfoDescription')
      if (!title || !description) return
      title.textContent = button.dataset.chartInfoTitle || 'Informações do gráfico'
      description.textContent = button.dataset.chartInfo || ''
      modal('chartInfoModal', true)
    }
  })

  $$('.modal [data-close]').forEach((b) => b.onclick = () => {
    if (b.dataset.close === 'loginModal' && state.profile?.role !== 'admin') return
    if (b.dataset.close === 'settingsModal' && schoolSetupRequired) return toast('Informe o nome da escola para concluir a configuração inicial.', 'error')
    modal(b.dataset.close, false)
  })

  if ($('#copyNotificationBtn')) $('#copyNotificationBtn').onclick = async () => { try { await navigator.clipboard.writeText($('#notificationMessage')?.value || ''); toast('Mensagem copiada.') } catch { toast('Não foi possível copiar.', 'error') } }
  if ($('#sendWhatsappBtn')) $('#sendWhatsappBtn').onclick = () => triggerNotification('whatsapp')
  if ($('#sendEmailBtn')) $('#sendEmailBtn').onclick = () => triggerNotification('email')
  if ($('#sendCoordinationBtn')) $('#sendCoordinationBtn').onclick = () => triggerNotification('coordination')

  if ($('#logoutBtn')) $('#logoutBtn').onclick = async () => {
    const isCredeAdmin = state.profile?.role === 'libris_admin'
    resetAdminState()
    localStorage.removeItem(LOCAL_SESSION_KEY)
    modal('loginModal', true)
    if (isCredeAdmin && auth) {
      try { await signOut(auth) } catch (err) { error(err, 'Não foi possível encerrar a sessão da CREDE.') }
    }
    toast('Sessão encerrada.')
  }
}

function setupFullscreenShortcut() {
  document.addEventListener('keydown', async (event) => {
    if (event.key !== 'F11' || event.repeat) return
    event.preventDefault()

    try {
      if (isTauri()) {
        const appWindow = getCurrentWindow()
        await appWindow.setFullscreen(!(await appWindow.isFullscreen()))
      } else if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await document.documentElement.requestFullscreen()
      }
    } catch (err) {
      console.error('Não foi possível alternar para tela cheia:', err)
      toast('Não foi possível alternar para tela cheia.', 'error')
    }
  })
}

/* -------------------------
   School settings
   ------------------------- */
function fillLibrisConfigurationForm(school = {}) {
  if ($('#librisConfigForm')) $('#librisConfigForm').dataset.schoolId = school.id || ''
  if ($('#librisSchoolInepInput')) $('#librisSchoolInepInput').value = school.inep || ''
  if ($('#librisSchoolNameInput')) $('#librisSchoolNameInput').value = school.name || ''
  if ($('#librisCoordinationEmailInput')) $('#librisCoordinationEmailInput').value = school.coordinationEmail || ''
  if ($('#librisSmtpHostInput')) $('#librisSmtpHostInput').value = school.smtp?.host || ''
  if ($('#librisSmtpPortInput')) $('#librisSmtpPortInput').value = String(school.smtp?.port || 587)
  if ($('#librisSmtpUsernameInput')) $('#librisSmtpUsernameInput').value = school.smtp?.username || ''
  if ($('#librisSmtpPasswordInput')) $('#librisSmtpPasswordInput').value = ''
  void updateEmailCredentialStatus('librisSmtpCredentialStatus', school.id)
  renderLocalAccountRows([])
}

function renderLocalAccountRows(accounts) {
  const container = $('#localAccountsList')
  if (!container) return
  container.replaceChildren()
  accounts.forEach((account) => addLocalAccountRow(account.email, account.id))
}

function addLocalAccountRow(email = '', id = '') {
  const container = $('#localAccountsList')
  if (!container) return
  const row = document.createElement('div')
  row.className = 'local-account-row'
  row.dataset.localAccountRow = ''
  row.dataset.userId = id
  const emailInput = document.createElement('input')
  emailInput.type = 'email'
  emailInput.autocomplete = 'off'
  emailInput.placeholder = 'email@escola.edu.br'
  emailInput.value = email
  emailInput.required = true
  emailInput.setAttribute('aria-label', 'Email da conta local')
  const passwordInput = document.createElement('input')
  passwordInput.type = 'password'
  passwordInput.autocomplete = 'new-password'
  passwordInput.placeholder = id ? 'Nova senha (vazio mantém a atual)' : 'Defina uma senha (mínimo 8 caracteres)'
  passwordInput.setAttribute('aria-label', 'Senha da conta local')
  passwordInput.dataset.localAccountPassword = ''
  passwordInput.required = !id
  const passwordField = document.createElement('div')
  passwordField.className = 'password-input'
  const passwordToggle = document.createElement('button')
  passwordToggle.type = 'button'
  passwordToggle.className = 'password-toggle'
  passwordToggle.textContent = '👁'
  passwordToggle.setAttribute('aria-label', 'Mostrar senha')
  passwordToggle.setAttribute('aria-pressed', 'false')
  passwordToggle.onclick = () => {
    const showing = passwordInput.type === 'password'
    passwordInput.type = showing ? 'text' : 'password'
    passwordToggle.setAttribute('aria-pressed', String(showing))
    passwordToggle.setAttribute('aria-label', showing ? 'Ocultar senha' : 'Mostrar senha')
  }
  passwordField.append(passwordInput, passwordToggle)
  const removeButton = document.createElement('button')
  removeButton.type = 'button'
  removeButton.className = 'small-btn danger'
  removeButton.textContent = 'Apagar'
  removeButton.onclick = () => row.remove()
  row.append(emailInput, passwordField, removeButton)
  container.append(row)
}

async function derivePasswordHash(password, salt, iterations = 310000) {
  if (!globalThis.crypto?.subtle) throw new Error('O armazenamento seguro de senhas não está disponível neste dispositivo.')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hashLocalPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return {
    passwordSalt: [...salt].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    passwordHash: await derivePasswordHash(password, salt),
    passwordIterations: 310000
  }
}

async function verifyLocalPassword(password, user) {
  const saltText = String(user.passwordSalt || '')
  if (!/^[a-f0-9]{32}$/i.test(saltText) || !user.passwordHash) return false
  const salt = new Uint8Array(saltText.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)))
  const iterations = Number(user.passwordIterations || 310000)
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false
  const hash = await derivePasswordHash(password, salt, iterations)
  if (hash.length !== user.passwordHash.length) return false
  let difference = 0
  for (let index = 0; index < hash.length; index += 1) difference |= hash.charCodeAt(index) ^ user.passwordHash.charCodeAt(index)
  return difference === 0
}

async function saveLibrisConfiguration(event) {
  event.preventDefault()
  if (state.profile?.role !== 'libris_admin') return toast('Somente a conta Libris pode alterar esta configuração.', 'error')

  const schoolInep = $('#librisSchoolInepInput')?.value.trim()
  const schoolName = $('#librisSchoolNameInput')?.value.trim()
  if (!/^\d{8}$/.test(schoolInep) || !schoolName) return toast('Informe o código INEP com 8 dígitos e o nome da escola.', 'error')
  const smtpHost = $('#librisSmtpHostInput')?.value.trim() || ''
  const smtpPort = Number($('#librisSmtpPortInput')?.value || 587)
  const smtpUsername = $('#librisSmtpUsernameInput')?.value.trim() || ''
  const smtpPassword = $('#librisSmtpPasswordInput')?.value || ''
  const smtpIsConfigured = Boolean(smtpHost || smtpUsername || smtpPassword)
  if (smtpIsConfigured && (!smtpHost || !smtpUsername || ![465, 587].includes(smtpPort))) {
    return toast('Para configurar SMTP, informe host, usuário/e-mail e porta segura 465 ou 587.', 'error')
  }
  if (smtpPassword && !isTauri()) {
    return toast('A senha SMTP só pode ser salva com segurança no aplicativo desktop Libris.', 'error')
  }
  const accounts = $$('[data-local-account-row]').map((row) => ({
    id: row.dataset.userId || '',
    email: row.querySelector('input[type="email"]')?.value.trim().toLowerCase() || '',
    password: row.querySelector('[data-local-account-password]')?.value || ''
  }))
  if (!accounts.length || accounts.some((account) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email))) return toast('Cadastre pelo menos uma conta com email válido.', 'error')
  if (new Set(accounts.map((account) => account.email)).size !== accounts.length) return toast('Cada email pode aparecer apenas uma vez.', 'error')
  if (accounts.some((account) => account.password && account.password.length < 8)) return toast('As senhas devem ter pelo menos 8 caracteres.', 'error')

  try {
    const existingSchools = await localStore.list('schools')
    const schoolId = existingSchools[0]?.id || schoolInep
    const existingSchool = existingSchools.find((item) => item.id === schoolId) || {}
    const existingSchoolSettings = { ...existingSchool }
    delete existingSchoolSettings.emailjs
    const school = {
      id: schoolId,
      schoolId,
      inep: schoolInep,
      name: schoolName,
      coordinationEmail: $('#librisCoordinationEmailInput')?.value.trim() || '',
      smtp: { host: smtpHost, port: smtpPort, username: smtpUsername },
      active: true,
      updatedAt: new Date()
    }
    const existingUsers = await localStore.list('users')
    const usersToSave = []
    for (const account of accounts) {
      const userId = `local-${encodeURIComponent(account.email)}`
      const previous = await localStore.get('users', account.id || userId)
      const credential = account.password
        ? await hashLocalPassword(account.password)
        : previous?.passwordHash && previous?.passwordSalt
          ? { passwordHash: previous.passwordHash, passwordSalt: previous.passwordSalt, passwordIterations: previous.passwordIterations || 310000 }
          : null
      if (!credential) throw new Error(`Defina uma senha para a nova conta ${account.email}.`)
      usersToSave.push({
        id: userId,
        email: account.email,
        role: 'admin',
        schoolId,
        active: true,
        ...credential,
        updatedAt: new Date()
      })
    }
    const batch = writeBatch(db)
    batch.set(doc(db, 'schools', schoolId), { ...existingSchoolSettings, ...school })
    existingUsers.filter((user) => user.schoolId === schoolId && user.role === 'admin').forEach((user) => {
      batch.set(doc(db, 'users', user.id), { ...user, active: false, updatedAt: new Date() }, { merge: true })
    })
    usersToSave.forEach((user) => batch.set(doc(db, 'users', user.id), user, { merge: true }))
    await batch.commit()
    if (smtpPassword) {
      try {
        await invoke('save_smtp_password', { schoolId, password: smtpPassword })
      } catch (err) {
        console.error('Configuração salva, mas a senha SMTP não foi salva:', err)
        return error(err, 'Configuração salva, mas não foi possível guardar a senha no cofre seguro. A senha não foi gravada localmente.')
      }
    }
    config.currentSchoolId = schoolId
    config.schoolName = schoolName
    config.smtp = school.smtp
    config.coordinationEmail = school.coordinationEmail
    if ($('#librisConfigForm')) $('#librisConfigForm').reset()
    resetAdminState()
    modal('loginModal', true)
    if (auth?.currentUser) await signOut(auth)
    toast('Configuração salva. As contas cadastradas já podem entrar com seus emails e senhas.')
  } catch (err) {
    error(err, 'Não foi possível salvar a configuração local.')
  }
}

async function saveSchoolSettings(event) {
  event.preventDefault()
  if (!db || !state.user) return toast('Entre com uma conta autorizada para alterar as configurações.', 'error')

  const schoolName = $('#schoolNameInput')?.value.trim() || ''
  const coordinationEmail = $('#coordinationEmailInput')?.value.trim() || ''

  const maxBooksStudent = Number($('#maxBooksStudentInput')?.value || config.maxBooksStudent || 2)
  const maxBooksTeacher = Number($('#maxBooksTeacherInput')?.value || config.maxBooksTeacher || 35)
  const studentLoanDays = Number($('#studentLoanDaysInput')?.value || 7)
  const teacherLoanDays = Number($('#teacherLoanDaysInput')?.value || 21)

  if (!schoolName) return toast('Informe o nome da escola para continuar.', 'error')
  if (!Number.isInteger(studentLoanDays) || studentLoanDays < 1 || studentLoanDays > 180 ||
      !Number.isInteger(teacherLoanDays) || teacherLoanDays < 1 || teacherLoanDays > 180) {
    return toast('Os prazos máximos devem ser números inteiros entre 1 e 180 dias.', 'error')
  }

  try {
    const schoolRef = doc(db, 'schools', config.currentSchoolId)
    const existingSchool = schoolSetupRequired ? await getDoc(schoolRef) : null
    const initialFields = schoolSetupRequired && !existingSchool?.exists() ? { active: true, bookSequences: {} } : {}
    await setDoc(schoolRef, {
      ...initialFields,
      name: schoolName,
      coordinationEmail,
      maxBooksStudent,
      maxBooksTeacher,
      studentLoanDays,
      teacherLoanDays,
      updatedAt: serverTimestamp()
    }, { merge: true })

    config.schoolName = schoolName
    config.coordinationEmail = coordinationEmail
    config.maxBooksStudent = maxBooksStudent
    config.maxBooksTeacher = maxBooksTeacher
    config.studentLoanDays = studentLoanDays
    config.teacherLoanDays = teacherLoanDays
    const selectedReader = state.readers.find((reader) => reader.id === $('#loanReaderIdInput')?.value)
    updateLoanDaysLimit(selectedReader)
    updateLoanQuantityLimit(selectedReader)
    syncSchoolSettingsForm(config)
    await logAudit(schoolSetupRequired ? 'school_initialized' : 'school_settings_updated', { schoolId: config.currentSchoolId, schoolName, coordinationEmail, maxBooksStudent, maxBooksTeacher, studentLoanDays, teacherLoanDays }, state.user?.uid || null)

    if (schoolSetupRequired) {
      if (!await loadSchoolData(config.currentSchoolId)) throw new Error('As configurações da escola não puderam ser recarregadas.')
      await subscribeAdmin()
      schoolSetupRequired = false
      if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configurações da escola'
      if ($('#adminView')) $('#adminView').hidden = false
      if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = false
      if ($('#logoutBtn')) $('#logoutBtn').hidden = false
      modal('loginModal', false)
      focusBookCodeInput()
    }

    modal('settingsModal', false)
    toast('Configurações salvas com sucesso.')
  } catch (err) {
    error(err, 'Não foi possível salvar as configurações da escola.')
  }
}

function syncSchoolSettingsForm(data = config) {
  const schoolNameInput = $('#schoolNameInput')
  const coordinationEmailInput = $('#coordinationEmailInput')
  const maxBooksStudentInput = $('#maxBooksStudentInput')
  const maxBooksTeacherInput = $('#maxBooksTeacherInput')
  const studentLoanDaysInput = $('#studentLoanDaysInput')
  const teacherLoanDaysInput = $('#teacherLoanDaysInput')
  const themePreferenceInput = $('#themePreferenceInput')
  const settings = data || {}

  if (schoolNameInput) schoolNameInput.value = settings.schoolName || ''
  if (coordinationEmailInput) coordinationEmailInput.value = settings.coordinationEmail || ''
  if (maxBooksStudentInput) maxBooksStudentInput.value = String(settings.maxBooksStudent ?? 2)
  if (maxBooksTeacherInput) maxBooksTeacherInput.value = String(settings.maxBooksTeacher ?? 35)
  if (studentLoanDaysInput) studentLoanDaysInput.value = String(settings.studentLoanDays ?? 7)
  if (teacherLoanDaysInput) teacherLoanDaysInput.value = String(settings.teacherLoanDays ?? 21)
  if (themePreferenceInput) themePreferenceInput.value = getThemePreference()
}

/* Load school settings after local email authorization. */
async function loadSchoolData(schoolId = config.currentSchoolId) {
  if (!db) return

  try {
    config.currentSchoolId = schoolId || config.currentSchoolId
    config.schoolName = ''
    config.coordinationEmail = ''
    config.reminderDays = 1
    config.coordinationDays = 7
    config.maxBooksStudent = 2
    config.maxBooksTeacher = 35
    config.studentLoanDays = 7
    config.teacherLoanDays = 21
    const school = await getDoc(doc(db, 'schools', config.currentSchoolId))
    if (school.exists()) {
      const data = school.data()
      config.schoolName = String(data.name || '').trim()
      config.coordinationEmail = data.coordinationEmail || ''
      config.reminderDays = Number(data.reminderDays ?? data.reminderBeforeDays ?? 1)
      config.coordinationDays = Number(data.coordinationDays ?? data.coordinationAfterDays ?? 7)
      config.maxBooksStudent = Number(data.maxBooksStudent ?? 2)
      config.maxBooksTeacher = Number(data.maxBooksTeacher ?? 35)
      config.studentLoanDays = Number(data.studentLoanDays ?? 7)
      config.teacherLoanDays = Number(data.teacherLoanDays ?? 21)
      config.smtp = {
        host: String(data.smtp?.host || ''),
        port: Number(data.smtp?.port || 587),
        username: String(data.smtp?.username || '')
      }
    } else {
      return false
    }
    const schoolNameNode = $('#schoolName')
    if (schoolNameNode) schoolNameNode.textContent = config.schoolName || 'Biblioteca escolar'
    syncSchoolSettingsForm()
    return Boolean(config.schoolName)
  } catch (err) {
    error(err, 'Não foi possível carregar a escola vinculada ao login.')
    return false
  }
}

async function enterSchoolPanel(user, persistSession = true) {
  if (!user?.active || user.role !== 'admin' || !user.schoolId) throw new Error('Esta conta não está ativa para uma escola.')
  state.user = { uid: user.id, email: user.email }
  state.profile = { role: 'admin', schoolId: user.schoolId, email: user.email, active: true }
  config.currentSchoolId = user.schoolId
  if (!await loadSchoolData(user.schoolId)) throw new Error('A escola desta conta ainda não foi configurada.')
  await subscribeAdmin()
  if (persistSession) {
    localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ userId: user.id, schoolId: user.schoolId }))
  }
  if ($('#adminView')) $('#adminView').hidden = false
  if ($('#librisAdminView')) $('#librisAdminView').hidden = true
  if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = false
  if ($('#logoutBtn')) $('#logoutBtn').hidden = false
  modal('loginModal', false)
  focusBookCodeInput()
}

async function handleLocalLogin(event) {
  event.preventDefault()
  const button = $('#localLoginBtn')
  const email = $('#localLoginEmailInput')?.value.trim().toLowerCase() || ''
  const password = $('#localLoginPasswordInput')?.value || ''
  loading(button, true, 'Validando acesso…')
  try {
    const users = await localStore.list('users')
    const user = users.find((record) => String(record.email || '').trim().toLowerCase() === email && record.active && record.role === 'admin')
    if (!user || !await verifyLocalPassword(password, user)) throw new Error('Email ou senha inválidos.')
    await enterSchoolPanel(user)
  } catch (err) {
    if (err?.message === 'Email ou senha inválidos.') toast(err.message, 'error')
    else error(err, 'Não foi possível iniciar a sessão local.')
  } finally {
    if ($('#localLoginPasswordInput')) $('#localLoginPasswordInput').value = ''
    loading(button, false)
  }
}

async function restoreLocalSession() {
  try {
    const session = JSON.parse(localStorage.getItem(LOCAL_SESSION_KEY) || 'null')
    if (!session?.userId || !session?.schoolId) return false
    const user = await localStore.get('users', session.userId)
    if (!user?.active || user.schoolId !== session.schoolId) {
      localStorage.removeItem(LOCAL_SESSION_KEY)
      return false
    }
    await enterSchoolPanel(user, false)
    return true
  } catch (err) {
    localStorage.removeItem(LOCAL_SESSION_KEY)
    error(err, 'Não foi possível restaurar a sessão local. Entre novamente.')
    return false
  }
}

async function handleCredeLogin(event) {
  event.preventDefault()
  const button = $('#credeLoginBtn')
  const email = $('#credeEmailInput')?.value.trim().toLowerCase() || ''
  const password = $('#credePasswordInput')?.value || ''
  loading(button, true, 'Validando acesso…')
  try {
    if (!auth) throw new Error('Autenticação administrativa indisponível. Verifique a configuração do Firebase.')
    const result = await signInWithEmailAndPassword(auth, email, password)
    state.user = result.user
    state.profile = { role: 'libris_admin', email: result.user.email || email }
    const schools = await localStore.list('schools')
    const school = schools[0] || {}
    fillLibrisConfigurationForm(school)
    if (school.id) {
      const users = (await localStore.list('users')).filter((user) => user.schoolId === school.id && user.role === 'admin' && user.active)
      renderLocalAccountRows(users)
    }
    if ($('#librisAdminView')) $('#librisAdminView').hidden = false
    if ($('#adminView')) $('#adminView').hidden = true
    if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = true
    if ($('#logoutBtn')) $('#logoutBtn').hidden = false
    if ($('#credeLoginForm')) $('#credeLoginForm').hidden = true
    if ($('#loginForm')) $('#loginForm').hidden = false
    modal('loginModal', false)
  } catch (err) {
    error(err, 'Não foi possível entrar como administração CREDE.')
  } finally {
    if ($('#credePasswordInput')) $('#credePasswordInput').value = ''
    loading(button, false)
  }
}

/* -------------------------
   Initialization
   ------------------------- */
setup()
setupFullscreenShortcut()
syncSchoolSettingsForm()

if ($('#importCsvBtn')) $('#importCsvBtn').onclick = () => modal('importCsvFileModal', true)
if ($('#importCsvInput')) $('#importCsvInput').onchange = importCsv
const cancelCsvFileSelection = () => { if ($('#importCsvInput')) $('#importCsvInput').value = ''; modal('importCsvFileModal', false) }
if ($('#cancelCsvFileBtn')) $('#cancelCsvFileBtn').onclick = cancelCsvFileSelection
if ($('#closeCsvFileModalBtn')) $('#closeCsvFileModalBtn').onclick = cancelCsvFileSelection
const cancelCsvImport = () => { pendingCsvImport = null; modal('importCsvConfirmModal', false) }
if ($('#cancelCsvImportBtn')) $('#cancelCsvImportBtn').onclick = cancelCsvImport
if ($('#closeCsvImportBtn')) $('#closeCsvImportBtn').onclick = cancelCsvImport
if ($('#confirmCsvImportBtn')) $('#confirmCsvImportBtn').onclick = confirmCsvImport

async function init() {
  updateReaderFields()
  renderCategorySelect()
  renderCategoryList()
  renderBooks()
  renderReaders()
  renderLoans()
  renderDashboard()
  const adminView = $('#adminView')
  const settingsButton = $('#openSettingsBtn')
  const logoutButton = $('#logoutBtn')
  if (adminView) adminView.hidden = true
  if (settingsButton) settingsButton.hidden = true
  if (logoutButton) logoutButton.hidden = true
  if ($('#librisAdminView')) $('#librisAdminView').hidden = true
  if ($('#loginForm')) $('#loginForm').hidden = false
  if ($('#credeLoginForm')) $('#credeLoginForm').hidden = true
  const restored = await restoreLocalSession()
  if (!restored) {
    modal('loginModal', true)
    $('#localLoginEmailInput')?.focus()
  }
}

init()

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('PWA indisponível:', err))
  })
}
