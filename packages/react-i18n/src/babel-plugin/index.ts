import path from 'path';

import glob from 'glob';
import stringHash from 'string-hash';
import {camelCase} from 'change-case';
import {TemplateBuilder} from '@babel/template';
import Types from '@babel/types';
import {Node, NodePath} from '@babel/traverse';

import {importModule, i18nCallExpression} from './babel-templates';
import {TRANSLATION_DIRECTORY_NAME, DEFAULT_FALLBACK_LOCALE} from './shared';

export const I18N_CALL_NAMES = ['useI18n', 'withI18n'];

export interface Options {
  mode?: 'from-generated-index' | 'from-generated-dictionary';
}

interface State {
  program: NodePath<Types.Program>;
  opts: Options;
}

export default function injectWithI18nArguments({
  types: t,
  template,
}: {
  types: typeof Types;
  template: TemplateBuilder<Types.ImportDeclaration | Types.ObjectExpression>;
}) {
  function addI18nArguments({
    binding,
    bindingName,
    filename,
    insertImport,
    fallback,
    translationIndexImportID,
    translationDictionaryImportID,
  }) {
    const {referencePaths} = binding;

    const referencePathsToRewrite = referencePaths.filter(referencePath => {
      const parent: Node = referencePath.parent;
      return (
        parent.type === 'CallExpression' &&
        (!parent.arguments || parent.arguments.length === 0)
      );
    });

    if (referencePathsToRewrite.length === 0) {
      return;
    }

    if (referencePathsToRewrite.length > 1) {
      throw new Error(
        `You attempted to use ${bindingName} ${
          referencePathsToRewrite.length
        } times in a single file. This is not supported by the Babel plugin that automatically inserts translations.`,
      );
    }

    let translationFilePaths;
    if (translationDictionaryImportID || translationIndexImportID) {
      if (!translationIndexFileExist(filename, TRANSLATION_DIRECTORY_NAME)) {
        return;
      }
    } else {
      translationFilePaths = getTranslationFilePaths(
        filename,
        TRANSLATION_DIRECTORY_NAME,
      );

      if (translationFilePaths.length === 0) {
        return;
      }
    }

    insertImport();

    referencePathsToRewrite[0].parentPath.replaceWith(
      i18nCallExpression(template, {
        id: generateID(filename),
        translationIndexImportID,
        bindingName,
        translationFilePaths,
        fallback,
        translationDictionaryImportID,
      }),
    );
  }

  return {
    visitor: {
      Program(nodePath: NodePath<Types.Program>, state: State) {
        state.program = nodePath;
      },
      ImportDeclaration(
        nodePath: NodePath<Types.ImportDeclaration>,
        state: State,
      ) {
        if (nodePath.node.source.value !== '@shopify/react-i18n') {
          return;
        }

        const {specifiers} = nodePath.node;
        specifiers.forEach(specifier => {
          if (
            !t.isImportSpecifier(specifier) ||
            !I18N_CALL_NAMES.includes(specifier.imported.name)
          ) {
            return;
          }

          const bindingName = specifier.local.name;
          const binding = nodePath.scope.getBinding(bindingName);

          if (!binding) {
            return;
          }

          const {mode} = state.opts;
          const fromGeneratedIndex = mode === 'from-generated-index';
          const fromGeneratedDictionary = mode === 'from-generated-dictionary';

          const fallback = fromGeneratedDictionary
            ? undefined
            : {
                locale: DEFAULT_FALLBACK_LOCALE,
                id: nodePath.scope.generateUidIdentifier(
                  camelCase(DEFAULT_FALLBACK_LOCALE),
                ).name,
              };

          const translationIndexImportID = fromGeneratedIndex
            ? '__shopify__i18n_translations'
            : undefined;

          const translationDictionaryImportID = fromGeneratedDictionary
            ? '__shopify__i18n_dictionary'
            : undefined;

          const {filename} = this.file.opts;

          addI18nArguments({
            binding,
            bindingName,
            filename,
            fallback,
            translationIndexImportID,
            translationDictionaryImportID,
            insertImport() {
              const {program} = state;

              if (fallback) {
                program.node.body.unshift(
                  importModule(template, {
                    id: fallback.id,
                    from: `./${TRANSLATION_DIRECTORY_NAME}/${
                      fallback.locale
                    }.json`,
                  }),
                );
              }

              if (translationIndexImportID) {
                program.node.body.unshift(
                  importModule(template, {
                    id: translationIndexImportID,
                    from: `./${TRANSLATION_DIRECTORY_NAME}`,
                  }),
                );
              }

              if (translationDictionaryImportID) {
                program.node.body.unshift(
                  importModule(template, {
                    id: translationDictionaryImportID,
                    from: `./${TRANSLATION_DIRECTORY_NAME}`,
                  }),
                );
              }
            },
          });
        });
      },
    },
  };
}

function getTranslationFilePaths(
  filename: string,
  translationDirName,
): string[] {
  return glob.sync(
    path.resolve(path.dirname(filename), translationDirName, '*.json'),
    {
      nodir: true,
    },
  );
}

function translationIndexFileExist(filename: string, translationDirName) {
  const indexFile = glob.sync(
    path.resolve(path.dirname(filename), translationDirName, 'index.js'),
    {
      nodir: true,
    },
  );

  return indexFile.length > 0;
}

// based on postcss-modules implementation
// see https://github.com/css-modules/postcss-modules/blob/60920a97b165885683c41655e4ca594d15ec2aa0/src/generateScopedName.js
function generateID(filename: string) {
  const hash = stringHash(filename)
    .toString(36)
    .substr(0, 5);
  const extension = path.extname(filename);
  const legible = path.basename(filename, extension);
  return `${legible}_${hash}`;
}
