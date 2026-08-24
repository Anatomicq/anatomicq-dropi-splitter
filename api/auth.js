// Endpoint de configuración OAuth de una sola vez. DESACTIVADO por seguridad:
// antes registraba el token de administrador en los logs y lo mostraba en la
// respuesta. El token ya está guardado en las variables de entorno de Vercel.
// Si algún día hay que re-autorizar la app, restaurar temporalmente desde el
// historial de git y volver a desactivar al terminar.
export default function handler(req, res) {
  return res.status(410).json({ error: "Endpoint de configuración desactivado." });
}
