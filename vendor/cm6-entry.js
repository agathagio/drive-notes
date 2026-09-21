// Fonte do pacote único do CodeMirror 6 usado pelo Drive Notes.
// NÃO é carregado pelo app: o app carrega o vendor/codemirror.js gerado a partir daqui.
// Pra regenerar, ver vendor/README.md.
//
// A lista é escolhida a dedo em vez de usar o basicSetup, que traz número de linha,
// gutter de dobra, painel de busca, autocompletar, fechamento de colchete, seleção
// retangular e realce de linha ativa: peso e comportamento indesejado num celular.
import { EditorView, drawSelection, keymap } from '@codemirror/view';
// Transaction vem pela anotação addToHistory: é ela que diz que trocar o texto inteiro
// (abrir uma nota) não é uma edição do usuário e não entra na pilha do desfazer.
//
// Prec: o markdown() instala o Enter dele em Prec.high (o addKeymap do pacote), e precedência
// vence posição na lista de extensões. Sem o Prec aqui, o Enter do app nunca roda.
// Compartment: é por ele que o history() é reconfigurado ao abrir outra nota, o que zera a pilha
// do desfazer. Sem zerar, um evento da nota anterior é remapeado pelo documento novo e desfazer
// cola pedaço da nota velha na nota recém-aberta.
import { EditorState, StateField, StateEffect, Transaction, Prec, Compartment } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import { history, undo, redo, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage, insertNewlineContinueMarkup, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';

window.CM6 = {
  EditorView, EditorState, StateField, StateEffect, Transaction, Prec, Compartment,
  Decoration, keymap, drawSelection,
  history, undo, redo, defaultKeymap, historyKeymap,
  markdown, markdownLanguage, insertNewlineContinueMarkup, insertNewlineContinueMarkupCommand,
  syntaxHighlighting, HighlightStyle, syntaxTree,
  tags,
  lineWrapping: EditorView.lineWrapping,
};
