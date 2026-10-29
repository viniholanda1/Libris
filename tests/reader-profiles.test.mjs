import test from 'node:test'
import assert from 'node:assert/strict'
import { isStudentReader, studentCourseLoans } from '../reader-profiles.mjs'

test('considera somente empréstimos de alunos com turma aplicável no gráfico', () => {
  const readers = [
    { id: 'student', type: 'Aluno', course: 'Informática 2024' },
    { id: 'teacher', type: 'Professor', course: 'Não se aplica' },
    { id: 'other', type: 'Outros', course: 'Não se aplica' },
    { id: 'student-without-course', type: 'Aluno', course: '' }
  ]
  const loans = [
    { id: 'loan-student', readerId: 'student', readerCourse: 'Informática 2024' },
    { id: 'loan-teacher', readerId: 'teacher', readerCourse: 'Não se aplica' },
    { id: 'loan-other', readerId: 'other', readerCourse: 'Não se aplica' },
    { id: 'loan-no-course', readerId: 'student-without-course', readerCourse: 'Não se aplica' },
    { id: 'loan-no-reader', readerId: 'missing', readerCourse: 'Não se aplica' }
  ]

  assert.deepEqual(studentCourseLoans(loans, readers), [loans[0]])
})

test('preserva a classificação existente de leitores sem perfil explícito', () => {
  assert.equal(isStudentReader({}), true)
  assert.equal(isStudentReader({ type: 'Professor' }), false)
  assert.equal(isStudentReader({ role: 'student' }), true)
})
