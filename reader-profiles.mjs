export function isStudentReader(reader) {
  const type = String(reader?.type || '').toLocaleLowerCase('pt-BR')
  const role = String(reader?.role || '').toLocaleLowerCase('pt-BR')
  return type === 'aluno' || role === 'student' || (!type && !role)
}

export function studentCourseLoans(activeLoans, readers) {
  const readersById = new Map(readers.map((reader) => [reader.id, reader]))

  return activeLoans.flatMap((loan) => {
    const reader = readersById.get(loan.readerId)
    if (!reader || !isStudentReader(reader)) return []

    const course = String(loan.readerCourse || reader.course || reader.class || '').trim()
    if (!course || course.toLocaleLowerCase('pt-BR') === 'não se aplica') return []

    return [{ ...loan, readerCourse: course }]
  })
}
