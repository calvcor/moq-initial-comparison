"""Idioma de los textos que redacta el orquestador para la página: el análisis de una campaña (analysis.py) y las
comparaciones de dos pruebas (compare.py) y de dos campañas (campaign_versus.py). La página pide el suyo con
?lang=en (docs/measurement.md); por defecto, español, como siempre.

Cada texto va como t("español", "English"), resuelto con el idioma de la petición en curso (una variable de contexto,
fijada con `language()` alrededor del cálculo). Las constantes de módulo con texto usan `Localized`: un dict cuyos
valores (es, en) se resuelven al leerlos, así que `METRICS[key]["label"]` sigue funcionando igual en los dos idiomas.
No se traducen los eventos de las campañas ni los motivos de invalidez (se guardan como texto al ocurrir), ni los
mensajes de error de la API.
"""
from contextlib import contextmanager
from contextvars import ContextVar

LANGS = ("es", "en")
_LANG: ContextVar[str] = ContextVar("lang", default="es")


def current() -> str:
    return _LANG.get()


def t(es: str, en: str) -> str:
    """El texto en el idioma de la petición en curso."""
    return en if _LANG.get() == "en" else es


@contextmanager
def language(lang: str):
    """Fija el idioma mientras dura el bloque. Uno desconocido cuenta como español."""
    token = _LANG.set(lang if lang in LANGS else "es")
    try:
        yield
    finally:
        _LANG.reset(token)


def _resolve(value):
    return t(*value) if isinstance(value, tuple) and len(value) == 2 and all(isinstance(v, str) for v in value) else value


class Localized(dict):
    """Dict cuyos valores (es, en) se leen en el idioma de la petición (con [], get, values e items)."""

    def __getitem__(self, key):
        return _resolve(super().__getitem__(key))

    def get(self, key, default=None):
        return _resolve(super().get(key, default))

    def values(self):
        return [_resolve(v) for v in super().values()]

    def items(self):
        return [(k, _resolve(v)) for k, v in super().items()]
