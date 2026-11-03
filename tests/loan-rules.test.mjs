import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countActiveLoanCopies,
  extendLoanDueDate,
  getLoanDueDate,
  getLoanQuantity,
  getMaximumLoanQuantity
} from '../loan-rules.mjs'

const readerId = 'student-1'

test('allows borrowing up to the student limit when stock is available', () => {
  assert.equal(getMaximumLoanQuantity({
    loanLimit: 2,
    activeLoans: [],
    readerId,
    availableCopies: 25
  }), 2)
})

test('counts active copies across all titles against the reader limit', () => {
  const activeLoans = [
    { id: 'loan-1', readerId, bookId: 'other-book', status: 'active', quantity: 1 },
    { id: 'loan-2', readerId: 'student-2', status: 'active', quantity: 1 }
  ]

  assert.equal(getMaximumLoanQuantity({
    loanLimit: 2,
    activeLoans,
    readerId,
    availableCopies: 25
  }), 1)
})

test('allows another loan of a title already borrowed when copies and reader capacity remain', () => {
  const activeLoans = [
    { id: 'existing', readerId, bookId: 'coraline', status: 'active', quantity: 1 }
  ]

  assert.equal(getMaximumLoanQuantity({
    loanLimit: 2,
    activeLoans,
    readerId,
    availableCopies: 24
  }), 1)
})

test('caps the permitted quantity by available stock', () => {
  assert.equal(getMaximumLoanQuantity({
    loanLimit: 2,
    activeLoans: [],
    readerId,
    availableCopies: 1
  }), 1)

  assert.equal(getMaximumLoanQuantity({
    loanLimit: 2,
    activeLoans: [],
    readerId,
    availableCopies: 0
  }), 0)
})

test('allows increasing an existing loan while preserving its current copies', () => {
  const activeLoans = [
    { id: 'current-loan', readerId, status: 'active', quantity: 1 }
  ]

  assert.equal(getMaximumLoanQuantity({
    loanLimit: 2,
    activeLoans,
    readerId,
    availableCopies: 24,
    currentLoanId: 'current-loan',
    currentLoanQuantity: 1
  }), 2)
})

test('caps an edited loan at the remaining reader limit even when its current quantity is higher', () => {
  const activeLoans = [
    { id: 'current-loan', readerId, status: 'active', quantity: 2 },
    { id: 'other-loan', readerId, status: 'active', quantity: 1 }
  ]

  assert.equal(getMaximumLoanQuantity({
    loanLimit: 2,
    activeLoans,
    readerId,
    availableCopies: 24,
    currentLoanId: 'current-loan',
    currentLoanQuantity: 2
  }), 1)
})

test('caps an edited loan by remaining physical stock after accounting for copies already on that loan', () => {
  const activeLoans = [
    { id: 'current-loan', readerId, status: 'active', quantity: 2 }
  ]

  assert.equal(getMaximumLoanQuantity({
    loanLimit: 10,
    activeLoans,
    readerId,
    availableCopies: 0,
    currentLoanId: 'current-loan',
    currentLoanQuantity: 2
  }), 2)

  assert.equal(getMaximumLoanQuantity({
    loanLimit: 10,
    activeLoans,
    readerId,
    availableCopies: 0,
    currentLoanId: 'current-loan',
    currentLoanQuantity: 3
  }), 3)
})

test('only counts active copies for the requested reader and normalizes legacy quantities', () => {
  const loans = [
    { id: 'active', readerId, status: 'active', quantity: 2 },
    { id: 'returned', readerId, status: 'returned', quantity: 3 },
    { id: 'missing-quantity', readerId, status: 'active' },
    { id: 'other-reader', readerId: 'student-2', status: 'active', quantity: 4 }
  ]

  assert.equal(countActiveLoanCopies(loans, readerId), 3)
  assert.equal(countActiveLoanCopies(loans, readerId, 'active'), 1)
  assert.equal(getLoanQuantity({ quantity: 0 }), 1)
})

test('renews from the current due date without changing the original checkout date', () => {
  const createdAt = new Date('2026-10-01T10:00:00')
  const dueDate = new Date('2026-10-08T10:00:00')
  const loan = { createdAt, dueDate }

  const renewedDueDate = extendLoanDueDate(loan, 7)

  assert.equal(renewedDueDate.toISOString(), '2026-10-15T10:00:00.000Z')
  assert.equal(loan.createdAt, createdAt)
  assert.equal(getLoanDueDate(loan), dueDate)
})

test('uses legacy dueAt values when dueDate is not present', () => {
  const legacyDueDate = new Date('2026-10-08T10:00:00')
  const loan = { dueAt: legacyDueDate }

  assert.equal(getLoanDueDate(loan), legacyDueDate)
  assert.equal(extendLoanDueDate(loan, 7).toISOString(), '2026-10-15T10:00:00.000Z')
})
