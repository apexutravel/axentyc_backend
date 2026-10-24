import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import express from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Behind nginx / a load balancer: use the real client IP for rate limiting
  if (configService.get('TRUST_PROXY') !== 'false') app.set('trust proxy', 1);

  // API only (no HTML): CSP is off so Swagger and the embeddable widget keep working;
  // cross-origin resource policy must allow the widget script and uploads on other sites.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(cookieParser());

  // Preserve raw request body for Facebook webhook signature verification
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        if (
          req.originalUrl &&
          (req.originalUrl.includes('/webhook/facebook') ||
            req.originalUrl.includes('/webhook/stripe'))
        ) {
          req.rawBody = buf;
        }
      },
    }),
  );
  app.use(
    express.urlencoded({
      extended: true,
      verify: (req: any, _res, buf) => {
        if (
          req.originalUrl &&
          (req.originalUrl.includes('/webhook/facebook') ||
            req.originalUrl.includes('/webhook/stripe'))
        ) {
          req.rawBody = buf;
        }
      },
    }),
  );

  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });

  const corsOrigin = configService.get('CORS_ORIGIN') || 'http://localhost:3000';
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || origin === corsOrigin) {
        callback(null, true);
      } else {
        // Public widget endpoints are embedded on customer-owned domains.
        callback(null, true);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.setGlobalPrefix(configService.get('API_PREFIX') || 'api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (configService.get('SWAGGER_ENABLED') === 'true') {
    const config = new DocumentBuilder()
      .setTitle('AXENTYC API')
      .setDescription('The AXENTYC API documentation')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = configService.get('PORT') || 3001;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: http://localhost:${port}`);
  if (configService.get('SWAGGER_ENABLED') === 'true') {
    logger.log(`Swagger documentation: http://localhost:${port}/api/docs`);
  }
}
bootstrap();
