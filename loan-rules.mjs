export function getLoanQuantity(loan) {
  const quantity = Number(loan?.quantity || 1)
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1
}

export function countActiveLoanCopies(loans, readerId, excludedLoanId = null) {
  return loans
    .filter((loan) => loan.status === 'active' && loan.readerId === readerId && loan.id !== excludedLoanId)
    .reduce((total, loan) => total + getLoanQuantity(loan), 0)
}

export function getMaximumLoanQuantity({
  loanLimit,
  activeLoans,
  readerId,
  availableCopies,
  currentLoanId = null,
  currentLoanQuantity = 0
}) {
  const parsedLimit = Number(loanLimit)
  const limit = Number.isSafeInteger(parsedLimit) ? Math.max(0, parsedLimit) : 0
  const parsedAvailable = Number(availableCopies)
  const available = Number.isSafeInteger(parsedAvailable) ? Math.max(0, parsedAvailable) : 0
  const currentQuantity = Number.isSafeInteger(currentLoanQuantity) && currentLoanQuantity > 0
    ? currentLoanQuantity
    : 0
  const otherActiveCopies = countActiveLoanCopies(activeLoans, readerId, currentLoanId)
  const limitCapacity = Math.max(0, limit - otherActiveCopies)
  const stockCapacity = available + currentQuantity

  return Math.max(currentQuantity, Math.min(limitCapacity, stockCapacity))
}
