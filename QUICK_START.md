# 🚀 Guía de Inicio Rápido

## Paso 1: Instalar MongoDB

Si no tienes MongoDB instalado:

```bash
# macOS con Homebrew
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community

# O descarga desde: https://www.mongodb.com/try/download/community
```

**Opción alternativa con Docker:**

```bash
# Iniciar MongoDB con Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

## Paso 2: Verificar que MongoDB esté corriendo

```bash
# Verificar conexión
mongosh

# O si usas Docker
docker ps | grep mongodb
```

## Paso 3: Configurar Variables de Entorno

El archivo `.env` ya está creado con valores por defecto. Si necesitas cambiar algo:

```bash
# Editar .env
nano .env
```

**IMPORTANTE**: Cambia `JWT_SECRET` en producción por un valor seguro.

## Paso 4: Instalar Dependencias (si no lo has hecho)

```bash
npm install
```

## Paso 5: Iniciar el Servidor

```bash
# Modo desarrollo (con hot-reload)
npm run start:dev
```

## Paso 6: Verificar que Funciona

Abre tu navegador en:

- **API**: http://localhost:3001/api/v1
- **Swagger Docs**: http://localhost:3001/api/docs
- **Health Check**: http://localhost:3001/api/v1/health

## 🎯 Probar la API

### 1. Registrar un Usuario

```bash
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123",
    "firstName": "John",
    "lastName": "Doe"
  }'
```

### 2. Iniciar Sesión

```bash
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123"
  }'
```

Guarda el `access_token` que recibes.

### 3. Obtener Perfil (con token)

```bash
curl -X GET http://localhost:3001/api/v1/auth/profile \
  -H "Authorization: Bearer TU_ACCESS_TOKEN_AQUI"
```

## 📚 Usar Swagger

La forma más fácil de probar la API es usando Swagger:

1. Abre http://localhost:3001/api/docs
2. Haz clic en "Authorize" (arriba a la derecha)
3. Ingresa tu token JWT
4. Prueba los endpoints directamente desde la interfaz

## ⚠️ Solución de Problemas

### Error: "Connection refused" en MongoDB

```bash
# Verificar que MongoDB está corriendo
brew services list

# Iniciar MongoDB
brew services start mongodb-community

# O con Docker
docker start mongodb
```

### Error: "MongoServerError"

```bash
# Verificar conexión a MongoDB
mongosh mongodb://localhost:27017/cconehub
```

### Puerto 3001 ya en uso

Cambia el puerto en `.env`:
```env
PORT=3002
```

## 🔄 Comandos Útiles

```bash
# Ver logs en desarrollo
npm run start:dev

# Compilar para producción
npm run build

# Ejecutar tests
npm run test

# Ver cobertura de tests
npm run test:cov

# Linting
npm run lint

# Formatear código
npm run format
```

## ✅ Todo Listo!

Ahora puedes:
- Conectar el frontend en http://localhost:3000
- Desarrollar nuevos módulos
- Agregar más endpoints
- Personalizar la autenticación

Para más información, consulta el [README.md](./README.md) completo.
