const BOOK_CODE_PATTERN = /^[A-Z0-9]{1,4}-\d{4}$/
const BOOK_CODE_IN_TEXT = /(?:^|[^A-Z0-9])([A-Z0-9]{1,4}-\d{4})(?:$|[^A-Z0-9])/i

export function parseBookScan(rawValue) {
  const value = String(rawValue || '').trim()
  let payload = null

  try {
    payload = JSON.parse(value)
  } catch {
    payload = null
  }

  const embeddedCode = value.match(BOOK_CODE_IN_TEXT)?.[1]
  return {
    schoolId: String(payload?.schoolId || payload?.s || '').trim(),
    bookId: String(payload?.bookId || payload?.b || '').trim(),
    code: String(payload?.code || payload?.c || embeddedCode || value).trim().toUpperCase()
  }
}

export function isCompleteBookScan(rawValue) {
  const { bookId, code } = parseBookScan(rawValue)
  return Boolean(bookId) || BOOK_CODE_PATTERN.test(code)
}
