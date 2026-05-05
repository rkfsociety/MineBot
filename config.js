'use strict'

/**
 * Общие настройки (без секретов). Логин/пароль — в auth.local.js (не в git).
 *
 * nLogin (OpeNLogin): https://github.com/nickuc-com/OpeNLogin
 * Плейсхолдер {password} подставляется из auth.local.js.
 */
module.exports = {
  auth: {
    loginCommand: '/login {password}',
    registerCommand: '/register {password} {password}',
    registerOnFirstJoin: false,
  },
  /** Локальная панель управления (только этот ПК при host 127.0.0.1) */
  web: {
    host: '127.0.0.1',
    port: 3847,
    openBrowser: true,
  },
}
