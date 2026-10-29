import test from 'node:test'
import assert from 'node:assert/strict'
import { isCompleteBookScan, parseBookScan } from '../book-scan.mjs'

test('normaliza código lido por scanner HID com Enter ou espaços finais', () => {
  assert.deepEqual(parseBookScan(' li-0002\r\n'), {
    schoolId: '',
    bookId: '',
    code: 'LI-0002'
  })
  assert.equal(isCompleteBookScan('LI-0002'), true)
})

test('interpreta o QR JSON produzido pelas etiquetas Libris', () => {
  assert.deepEqual(parseBookScan('{"v":1,"s":"school-a","b":"book-1","c":"LI-0002"}'), {
    schoolId: 'school-a',
    bookId: 'book-1',
    code: 'LI-0002'
  })
  assert.equal(isCompleteBookScan('{"v":1,"s":"school-a","b":"book-1","c":"LI-0002"}'), true)
})

test('não considera uma leitura parcial como código completo', () => {
  assert.equal(isCompleteBookScan('LI-00'), false)
  assert.equal(isCompleteBookScan(''), false)
})
