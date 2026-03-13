# CconeHub Backend API

Backend API para CconeHub construido con NestJS, Mongoose, MongoDB y JWT Authentication.

## 📋 Tabla de Contenidos

- [Características](#características)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Requisitos Previos](#requisitos-previos)
- [Instalación](#instalación)
- [Configuración](#configuración)
- [Ejecución](#ejecución)
- [API Endpoints](#api-endpoints)
- [Testing](#testing)
- [Arquitectura](#arquitectura)

## ✨ Características

- **Autenticación JWT** - Sistema completo de autenticación con tokens JWT
- **Mongoose** - ODM elegante para MongoDB
- **Validación** - Validación automática de DTOs con class-validator
- **Swagger** - Documentación automática de la API
- **Guards Globales** - Protección de rutas con JWT Guard
- **Error Handling** - Manejo centralizado de errores
- **CORS** - Configurado para trabajar con el frontend
- **TypeScript** - Tipado estático completo

## 📁 Estructura del Proyecto

```
backend/
├── src/
│   ├── auth/                    # Módulo de autenticación
│   │   ├── dto/                 # DTOs para login y registro
│   │   ├── guards/              # JWT Auth Guard
│   │   ├── strategies/          # JWT Strategy
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   └── auth.module.ts
│   ├── users/                   # Módulo de usuarios
│   │   ├── dto/                 # DTOs para CRUD de usuarios
│   │   ├── entities/            # User Entity
│   │   ├── users.controller.ts
│   │   ├── users.service.ts
│   │   └── users.module.ts
│   ├── common/                  # Recursos compartidos
│   │   ├── decorators/          # Decoradores personalizados (@Public, @CurrentUser)
│   │   ├── filters/             # Filtros de excepciones
│   │   └── interceptors/        # Interceptores de respuesta
│   ├── config/                  # Configuraciones
│   │   ├── database.config.ts   # Configuración de TypeORM
│   │   └── jwt.config.ts        # Configuración de JWT
│   ├── app.module.ts            # Módulo principal
│   └── main.ts                  # Punto de entrada
├── .env                         # Variables de entorno
├── .env.example                 # Ejemplo de variables de entorno
└── package.json
```

## 🔧 Requisitos Previos

- Node.js >= 18
- MongoDB >= 5.0
- npm o yarn

## 📦 Instalación

```bash
# Instalar dependencias
npm install
```

## ⚙️ Configuración

1. Copiar el archivo de ejemplo de variables de entorno:

```bash
cp .env.example .env
```

2. Configurar las variables de entorno en `.env`:

```env
# Application
NODE_ENV=development
PORT=3001
API_PREFIX=api/v1

# Database - MongoDB
MONGODB_URI=mongodb://localhost:27017/cconehub

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRATION=7d

# CORS
CORS_ORIGIN=http://localhost:3000

# Swagger
SWAGGER_ENABLED=true
```

3. Asegúrate de que MongoDB esté corriendo:

```bash
# Si usas Homebrew
brew services start mongodb-community

# O con Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

## 🚀 Ejecución

```bash
# Modo desarrollo
npm run start:dev

# Modo producción
npm run build
npm run start:prod
```

La aplicación estará disponible en:
- API: `http://localhost:3001/api/v1`
- Swagger Docs: `http://localhost:3001/api/docs`

## 📡 API Endpoints

### Autenticación

| Método | Endpoint | Descripción | Autenticación |
|--------|----------|-------------|---------------|
| POST | `/api/v1/auth/register` | Registrar nuevo usuario | No |
| POST | `/api/v1/auth/login` | Iniciar sesión | No |
| GET | `/api/v1/auth/profile` | Obtener perfil del usuario actual | Sí |

### Usuarios

| Método | Endpoint | Descripción | Autenticación |
|--------|----------|-------------|---------------|
| GET | `/api/v1/users` | Listar todos los usuarios | Sí |
| GET | `/api/v1/users/:id` | Obtener usuario por ID | Sí |
| POST | `/api/v1/users` | Crear nuevo usuario | Sí |
| PATCH | `/api/v1/users/:id` | Actualizar usuario | Sí |
| DELETE | `/api/v1/users/:id` | Eliminar usuario | Sí |

### Health Check

| Método | Endpoint | Descripción | Autenticación |
|--------|----------|-------------|---------------|
| GET | `/api/v1/` | Health check básico | No |
| GET | `/api/v1/health` | Health check detallado | No |

## 🧪 Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## 🏗️ Arquitectura

### Módulos Principales

- **AuthModule**: Maneja autenticación y autorización con JWT
- **UsersModule**: CRUD completo de usuarios
- **ConfigModule**: Configuración centralizada con variables de entorno

### Patrones Implementados

- **DTO Pattern**: Validación y transformación de datos
- **Repository Pattern**: Abstracción de acceso a datos con TypeORM
- **Guard Pattern**: Protección de rutas con JWT
- **Decorator Pattern**: Decoradores personalizados para metadata
- **Filter Pattern**: Manejo centralizado de excepciones
- **Interceptor Pattern**: Transformación de respuestas

### Seguridad

- Contraseñas hasheadas con bcrypt
- JWT para autenticación stateless
- Guards globales con decorador @Public para rutas públicas
- Validación de DTOs con class-validator
- CORS configurado

### Base de Datos

- MongoDB con Mongoose
- Schemas con decoradores de Mongoose
- Timestamps automáticos (createdAt, updatedAt)
- Validaciones a nivel de schema y aplicación

## 📝 Notas para Desarrolladores

1. **Agregar nuevos módulos**: Usar `nest g module nombre-modulo`
2. **Crear controllers**: Usar `nest g controller nombre-controller`
3. **Crear services**: Usar `nest g service nombre-service`
4. **Rutas protegidas**: Por defecto todas las rutas están protegidas. Usar `@Public()` para rutas públicas
5. **Obtener usuario actual**: Usar decorador `@CurrentUser()` en los controllers
6. **Validación**: Todos los DTOs deben usar decoradores de class-validator

## 🔄 Próximos Pasos

- [ ] Implementar roles y permisos
- [ ] Agregar refresh tokens
- [ ] Implementar rate limiting
- [ ] Agregar logging con Winston
- [ ] Implementar caching con Redis
- [ ] Agregar más tests unitarios y e2e

## 📚 Recursos

- [NestJS Documentation](https://docs.nestjs.com)
- [Mongoose Documentation](https://mongoosejs.com)
- [MongoDB Documentation](https://www.mongodb.com/docs)
- [Passport JWT](http://www.passportjs.org/packages/passport-jwt/)

## 📄 Licencia

MIT
