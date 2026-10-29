export function normalizeIsbn(value) {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase()
}

export function isValidIsbn(value) {
  const isbn = normalizeIsbn(value)
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const checksum = [...isbn].reduce((sum, digit, index) => {
      const value = digit === 'X' ? 10 : Number(digit)
      return sum + value * (10 - index)
    }, 0)
    return checksum % 11 === 0
  }
  if (/^\d{13}$/.test(isbn)) {
    const checksum = [...isbn.slice(0, 12)].reduce((sum, digit, index) => {
      return sum + Number(digit) * (index % 2 === 0 ? 1 : 3)
    }, 0)
    return (10 - checksum % 10) % 10 === Number(isbn[12])
  }
  return false
}
