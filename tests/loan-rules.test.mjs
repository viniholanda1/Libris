import test from 'node:test'
import assert from 'node:assert/strict'
import { countActiveLoanCopies, getLoanQuantity, getMaximumLoanQuantity } from '../loan-rules.mjs'

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

test('preserves an existing loan if the reader is already at the limit', () => {
  const activeLoans = [
    { id: 'current-loan', readerId, status: 'active', quantity: 1 },
    { id: 'other-loan', readerId, status: 'active', quantity: 1 }
  ]

  assert.equal(getMaximumLoanQuantity({
    loanLimit: 2,
    activeLoans,
    readerId,
    availableCopies: 24,
    currentLoanId: 'current-loan',
    currentLoanQuantity: 1
  }), 1)
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
