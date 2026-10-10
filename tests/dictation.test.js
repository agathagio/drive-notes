// Drive Notes: rule-based cleanup of dictated text (app/dictation.js), run with node:test.
const test = require('node:test');
const assert = require('node:assert/strict');
const Dictation = require('../app/dictation.js');

// The acceptance table of task T14 (PLAN.md, phase 3), input -> output.
const TABLE = [
  ['eu fui no no mercado vírgula mas mas esqueci a carteira ponto final', 'Eu fui no mercado, mas esqueci a carteira.'],
  ['já... já... já vou sair', 'Já vou sair.'],
  ['como eu faço isso', 'Como eu faço isso?'],
  ['foi muito muito bom', 'Foi muito muito bom.'],
  ['hã eu acho que que sim', 'Eu acho que sim.'],
  ['- comprar pão pão', '- Comprar pão'],
  ['veja [[drive-notes]] e roda o teste', 'Veja [[drive-notes]] e roda o teste.'],
  ['eu queria ir eu queria ir mas choveu', 'Eu queria ir, mas choveu.'],
  ['primeira coisa nova linha segunda coisa aqui', 'Primeira coisa\nSegunda coisa aqui.'],
  ['## título da seção', '## Título da seção'],
];

// Cases beyond the table, each pinning one reading of the spec.
const EXTRA = [
  // "ponto" alone is a word, never a sign
  ['o ponto de partida é aqui', 'O ponto de partida é aqui.'],
  // Three copies of a KEEP_DOUBLED word collapse to one: the exception is for exactly two
  ['foi muito muito muito bom', 'Foi muito bom.'],
  // A KEEP_DOUBLED pair separated by a comma is a repetition, not emphasis
  ['foi muito, muito bom', 'Foi muito bom.'],
  // A single "é" is the verb; "éé" is hesitation
  ['éé isso é bom', 'Isso é bom.'],
  // Questions keep the question mark; the "?" command is honored
  ['por que você saiu', 'Por que você saiu?'],
  ['você vem interrogação', 'Você vem?'],
  // Longest command first: "ponto e vírgula" is not "ponto" + "e" + ","
  ['comprei pão ponto e vírgula leite também', 'Comprei pão; leite também.'],
  ['tenho dois pontos arroz e feijão', 'Tenho: arroz e feijão.'],
  // Capital after a sentence end inside the line
  ['fui ao mercado ponto final depois voltei', 'Fui ao mercado. Depois voltei.'],
  // Numbers are not broken by spacing
  ['custou 3,5 reais hoje', 'Custou 3,5 reais hoje.'],
  // Parentheses
  ['isso abre parênteses talvez fecha parênteses funciona', 'Isso (talvez) funciona.'],
  // Paragraph break
  ['um dois três novo parágrafo quatro cinco seis', 'Um dois três.\n\nQuatro cinco seis.'],
  // Code span, URL and link target come back byte for byte
  ['roda `npm test` agora mesmo', 'Roda `npm test` agora mesmo.'],
  ['abre https://example.com/a,b?x=1 no navegador', 'Abre https://example.com/a,b?x=1 no navegador.'],
  ['leia [o guia](https://example.com/guia.md) com calma', 'Leia [o guia](https://example.com/guia.md) com calma.'],
  // A fenced code block passes through untouched, fences included
  ['```\nfoo foo vírgula bar\n```\nok ok tudo certo', '```\nfoo foo vírgula bar\n```\nOk tudo certo.'],
  // Other line markers
  ['- [ ] ligar ligar pro veterinário', '- [ ] Ligar pro veterinário'],
  ['1. primeiro item da lista', '1. Primeiro item da lista'],
  // A quote is neither a list nor a heading, so it gets the sentence end
  ['> citação de alguém aqui', '> Citação de alguém aqui.'],
  // A file name is not split by the spacing step
  ['abre o app.js agora mesmo', 'Abre o app.js agora mesmo.'],
  // Short lines get no period
  ['ok obrigada', 'Ok obrigada'],
  // Never lower-cases
  ['Usei o GitHub hoje', 'Usei o GitHub hoje.'],
];

// One test per row, so a failure names the row
for (const [input, expected] of TABLE) {
  test(`table: ${input}`, () => assert.equal(Dictation.clean(input), expected));
}

for (const [input, expected] of EXTRA) {
  test(`extra: ${input}`, () => assert.equal(Dictation.clean(input), expected));
}

test('idempotence: clean(clean(x)) === clean(x)', () => {
  for (const [input] of [...TABLE, ...EXTRA]) {
    const once = Dictation.clean(input);
    assert.equal(Dictation.clean(once), once, `input: ${input}`);
  }
});

test('empty text and already clean text come back identical', () => {
  assert.equal(Dictation.clean(''), '');
  const clean = 'Eu fui no mercado, mas esqueci a carteira.';
  assert.equal(Dictation.clean(clean), clean);
  const note = '## Compras\n\n- Pão\n- [ ] Leite\n\nTudo certo por aqui.';
  assert.equal(Dictation.clean(note), note);
});
