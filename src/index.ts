#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance, AxiosResponse } from "axios";
import dotenv from "dotenv";
import { CertificateManager, CertificateConfig } from "./certificate-manager.js";
import { execAsync } from "./utils.js";

// Carrega as configurações do arquivo .env
dotenv.config();

interface PJEConfig {
  baseUrl: string;
  ssoUrl?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  appName?: string;
  certificate?: CertificateConfig;
}

interface PJEResponse<T = any> {
  status: "ok" | "error" | "in-progress";
  code: string;
  messages: string[];
  result: T;
  "page-info"?: {
    current: number;
    last: number;
    size: number;
    count: number;
  };
}

class PJEClient {
  private axiosInstance: AxiosInstance;
  private accessToken?: string;
  private config: PJEConfig;
  private certificateManager?: CertificateManager;

  constructor(config: PJEConfig) {
    this.config = config;
    
    const axiosConfig: any = {
      baseURL: config.baseUrl,
      headers: {
        "Content-Type": "application/json",
      },
      timeout: parseInt(process.env.PJE_TIMEOUT_MS || "30000"),
    };
    
    if (config.certificate) {
      this.certificateManager = new CertificateManager(config.certificate);
    }
    
    this.axiosInstance = axios.create(axiosConfig);

    this.axiosInstance.interceptors.request.use((config) => {
      if (this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`;
      }
      if (this.config.appName) {
        config.headers["X-pje-legacy-app"] = this.config.appName;
      }
      return config;
    });
  }

  async initializeCertificate(): Promise<void> {
    if (!this.certificateManager) {
      throw new Error("Nenhum certificado configurado");
    }
    
    try {
      await this.certificateManager.initialize();
      
      const httpsAgent = this.certificateManager.getHttpsAgent();
      
      this.axiosInstance = axios.create({
        baseURL: this.config.baseUrl,
        headers: {
          "Content-Type": "application/json",
        },
        timeout: parseInt(process.env.PJE_TIMEOUT_MS || "30000"),
        httpsAgent: httpsAgent
      });
      
      this.axiosInstance.interceptors.request.use((config) => {
        if (this.accessToken) {
          config.headers.Authorization = `Bearer ${this.accessToken}`;
        }
        if (this.config.appName) {
          config.headers["X-pje-legacy-app"] = this.config.appName;
        }
        return config;
      });
    } catch (error) {
      throw new Error(`Erro ao inicializar certificado: ${error}`);
    }
  }
  
  async authenticateWithCertificate(): Promise<void> {
    if (!this.certificateManager) {
      throw new Error("Certificado não inicializado");
    }
    
    try {
      const response = await this.axiosInstance.post('/api/v1/auth/certificate', {
        certificate: this.certificateManager.getCertificate()
      });
      
      this.accessToken = response.data.access_token;
    } catch (error) {
      throw new Error(`Erro na autenticação por certificado: ${error}`);
    }
  }
  
  getCertificateInfo(): any {
    if (!this.certificateManager) {
      throw new Error("Nenhum certificado configurado");
    }
    return this.certificateManager.getCertificateInfo();
  }

  async authenticate(): Promise<void> {
    if (!this.config.ssoUrl || !this.config.clientId || !this.config.clientSecret) {
      throw new Error("Configuração de SSO incompleta");
    }

    try {
      const response = await axios.post(
        this.config.ssoUrl,
        new URLSearchParams({
          grant_type: "password",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          username: this.config.username || "",
          password: this.config.password || "",
          scope: "openid",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      this.accessToken = response.data.access_token;
    } catch (error) {
      throw new Error(`Erro na autenticação: ${error}`);
    }
  }

  async listarProcessos(filter?: any, fields?: string[], order?: any, page?: number, size?: number): Promise<PJEResponse> {
    const params: any = {};
    
    if (filter) {
      params.filter = typeof filter === "string" ? filter : JSON.stringify(filter);
    }
    if (fields) {
      params.fields = Array.isArray(fields) ? JSON.stringify(fields) : fields;
    }
    if (order) {
      params.order = typeof order === "string" ? order : JSON.stringify(order);
    }
    if (page || size) {
      params.page = JSON.stringify({ page: page || 1, size: size || 20 });
    }

    const response = await this.axiosInstance.get("/api/v1/processos", { params });
    return response.data;
  }

  async buscarProcesso(id: string): Promise<PJEResponse> {
    const response = await this.axiosInstance.get(`/api/v1/processos/${id}`);
    return response.data;
  }

  async listarOrgaosJulgadores(): Promise<PJEResponse> {
    const response = await this.axiosInstance.get("/api/v1/orgaos-julgadores");
    return response.data;
  }

  async listarClasses(): Promise<PJEResponse> {
    const response = await this.axiosInstance.get("/api/v1/classes");
    return response.data;
  }

  async listarAssuntos(): Promise<PJEResponse> {
    const response = await this.axiosInstance.get("/api/v1/assuntos");
    return response.data;
  }
}

class PJEServer {
  private server: Server;
  private pjeClient?: PJEClient;

  constructor() {
    this.server = new Server(
      {
        name: "pje-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "pje_configurar",
            description: "Configura a conexão com o PJE",
            inputSchema: {
              type: "object",
              properties: {
                baseUrl: { type: "string", description: "URL base da API do PJE" },
                appName: { type: "string", description: "Nome da aplicação" },
              },
              required: ["baseUrl"],
            },
          },
          {
            name: "pje_listar_processos",
            description: "Lista processos com filtros opcionais",
            inputSchema: {
              type: "object",
              properties: {
                filter: { type: "string", description: "Filtro para busca" },
                page: { type: "number", description: "Número da página" },
                size: { type: "number", description: "Tamanho da página" },
              },
            },
          },
          {
            name: "pje_buscar_processo",
            description: "Busca um processo específico por ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "ID do processo" },
              },
              required: ["id"],
            },
          },
          {
            name: "pje_listar_orgaos_julgadores",
            description: "Lista órgãos julgadores",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "pje_listar_classes",
            description: "Lista classes processuais",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "pje_listar_assuntos",
            description: "Lista assuntos processuais",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "pje_status",
            description: "Verifica o status da configuração e conexão do PJE",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "pje_configurar_certificado",
            description: "Configura autenticação por certificado digital",
            inputSchema: {
              type: "object",
              properties: {
                pfxPath: { type: "string", description: "Caminho para arquivo .pfx/.p12" },
                pfxPassword: { type: "string", description: "Senha do arquivo .pfx/.p12" },
                certificateThumbprint: { type: "string", description: "Thumbprint do certificado no Windows" },
                certificateSubject: { type: "string", description: "Subject do certificado no Windows" },
              },
            },
          },
          {
            name: "pje_listar_certificados",
            description: "Lista certificados digitais disponíveis no Windows",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "pje_info_certificado",
            description: "Mostra informações sobre o certificado configurado",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case "pje_configurar":
            return await this.configurarPJE(request.params.arguments);
          case "pje_listar_processos":
            if (!this.pjeClient) throw new Error("PJE não configurado");
            return await this.listarProcessos(request.params.arguments);
          case "pje_buscar_processo":
            if (!this.pjeClient) throw new Error("PJE não configurado");
            return await this.buscarProcesso(request.params.arguments);
          case "pje_listar_orgaos_julgadores":
            if (!this.pjeClient) throw new Error("PJE não configurado");
            return await this.listarOrgaosJulgadores();
          case "pje_listar_classes":
            if (!this.pjeClient) throw new Error("PJE não configurado");
            return await this.listarClasses();
          case "pje_listar_assuntos":
            if (!this.pjeClient) throw new Error("PJE não configurado");
            return await this.listarAssuntos();
          case "pje_status":
            return await this.verificarStatus();
          case "pje_configurar_certificado":
            return await this.configurarCertificado(request.params.arguments);
          case "pje_listar_certificados":
            return await this.listarCertificados();
          case "pje_info_certificado":
            return await this.infoCertificado();
          default:
            throw new Error(`Ferramenta desconhecida: ${request.params.name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Erro: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    });
  }

  private async configurarPJE(args: any) {
    const config: PJEConfig = {
      baseUrl: args.baseUrl || process.env.PJE_BASE_URL || "https://pje.tjce.jus.br",
      appName: args.appName || process.env.PJE_APP_NAME || "pje-tjce-1g",
      ssoUrl: args.ssoUrl || process.env.PJE_SSO_URL,
      clientId: args.clientId || process.env.PJE_CLIENT_ID,
      clientSecret: args.clientSecret || process.env.PJE_CLIENT_SECRET,
      username: args.username || process.env.PJE_USERNAME,
      password: args.password || process.env.PJE_PASSWORD,
    };
    
    const thumbprint = args.certificateThumbprint || process.env.PJE_CERTIFICATE_THUMBPRINT;
    const certPassword = args.certificatePassword || process.env.PJE_CERTIFICATE_PASSWORD;
    const certPfxPath = args.certificatePfxPath || process.env.PJE_CERTIFICATE_PFX_PATH;

    let certificateConfig: CertificateConfig | undefined;
    if (thumbprint || certPfxPath) {
      certificateConfig = {
        certificateThumbprint: thumbprint || "",
        certificatePassword: certPassword || "",
        pfxPath: certPfxPath,
      };
      config.certificate = certificateConfig;
    }

    this.pjeClient = new PJEClient(config);

    if (certificateConfig) {
      try {
        await this.pjeClient.initializeCertificate();
        try {
          await this.pjeClient.authenticateWithCertificate();
          return {
            content: [
              {
                type: "text",
                text: `✅ PJE configurado com sucesso!\n\n🎯 **Configuração:**\n- URL: ${config.baseUrl}\n- App: ${config.appName}\n- Autenticação: 🔐 Certificado Digital\n\n✅ **Pronto para usar todas as funcionalidades!**`,
              },
            ],
          };
        } catch (authError) {
          return {
            content: [
              {
                type: "text",
                text: `⚠️ PJE configurado com certificado!\n\n🎯 **Configuração:**\n- URL: ${config.baseUrl}\n- App: ${config.appName}\n- Certificado: ✅ Carregado\n- Autenticação: ⚠️ Falha na autenticação\n\n**Erro:** ${authError instanceof Error ? authError.message : String(authError)}`,
              },
            ],
          };
        }
      } catch (certError) {
        return {
          content: [
            {
              type: "text",
              text: `❌ PJE configurado sem certificado!\n\n🎯 **Configuração:**\n- URL: ${config.baseUrl}\n- App: ${config.appName}\n- Certificado: ❌ Erro ao carregar\n\n**Erro:** ${certError instanceof Error ? certError.message : String(certError)}`,
            },
          ],
        };
      }
    }

    if (config.ssoUrl && config.clientId && config.clientSecret && config.username && config.password) {
      try {
        await this.pjeClient.authenticate();
        return {
          content: [
            {
              type: "text",
              text: `✅ PJE configurado com sucesso!\n\n🎯 **Configuração:**\n- URL: ${config.baseUrl}\n- App: ${config.appName}\n- Autenticação: ✅ SSO autenticado\n\n✅ **Pronto para usar todas as funcionalidades!**`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️ PJE configurado com erro na autenticação!\n\n🎯 **Configuração:**\n- URL: ${config.baseUrl}\n- App: ${config.appName}\n- Autenticação: ❌ Falha no SSO\n\n❌ **Erro:** ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `✅ PJE configurado!\n\n🎯 **Configuração:**\n- URL: ${config.baseUrl}\n- App: ${config.appName}\n- Autenticação: ⚠️ Apenas consultas públicas\n\n💡 **Para funcionalidades completas:**\nConfigure certificado digital ou credenciais no arquivo .env`,
        },
      ],
    };
  }

  private async listarProcessos(args: any) {
    const { filter, page, size } = args;
    const result = await this.pjeClient!.listarProcessos(filter, undefined, undefined, page, size);

    return {
      content: [
        {
          type: "text",
          text: `📋 **Processos encontrados:**\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async buscarProcesso(args: any) {
    const { id } = args;
    const result = await this.pjeClient!.buscarProcesso(id);

    return {
      content: [
        {
          type: "text",
          text: `📄 **Detalhes do processo:**\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async listarOrgaosJulgadores() {
    const result = await this.pjeClient!.listarOrgaosJulgadores();

    return {
      content: [
        {
          type: "text",
          text: `🏛️ **Órgãos julgadores:**\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async listarClasses() {
    const result = await this.pjeClient!.listarClasses();

    return {
      content: [
        {
          type: "text",
          text: `📚 **Classes processuais:**\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async listarAssuntos() {
    const result = await this.pjeClient!.listarAssuntos();

    return {
      content: [
        {
          type: "text",
          text: `📑 **Assuntos processuais:**\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async verificarStatus() {
    const envConfig = {
      baseUrl: process.env.PJE_BASE_URL,
      appName: process.env.PJE_APP_NAME,
      ssoUrl: process.env.PJE_SSO_URL,
      clientId: process.env.PJE_CLIENT_ID,
      clientSecret: process.env.PJE_CLIENT_SECRET,
      username: process.env.PJE_USERNAME ? '***' : undefined,
      password: process.env.PJE_PASSWORD ? '***' : undefined,
      certificatePath: process.env.PJE_CERTIFICATE_PFX_PATH,
      certificatePassword: process.env.PJE_CERTIFICATE_PFX_PASSWORD ? '***' : undefined,
      certificateThumbprint: process.env.PJE_CERTIFICATE_THUMBPRINT,
    };

    let statusText = `🔍 **STATUS DO PJE MCP SERVER**\n\n`;
    statusText += `🔧 **Configuração do arquivo .env:**\n`;
    statusText += `- URL Base: ${envConfig.baseUrl || '❌ Não configurado'}\n`;
    statusText += `- App Name: ${envConfig.appName || '❌ Não configurado'}\n`;
    statusText += `- SSO URL: ${envConfig.ssoUrl || '❌ Não configurado'}\n`;
    statusText += `- Client ID: ${envConfig.clientId || '❌ Não configurado'}\n`;
    statusText += `- Client Secret: ${envConfig.clientSecret || '❌ Não configurado'}\n`;
    statusText += `- Username: ${envConfig.username || '❌ Não configurado'}\n`;
    statusText += `- Password: ${envConfig.password || '❌ Não configurado'}\n\n`;
    
    statusText += `🔐 **Certificado Digital:**\n`;
    statusText += `- Arquivo PFX: ${envConfig.certificatePath || '❌ Não configurado'}\n`;
    statusText += `- Senha PFX: ${envConfig.certificatePassword || '❌ Não configurado'}\n`;
    statusText += `- Thumbprint: ${envConfig.certificateThumbprint || '❌ Não configurado'}\n\n`;

    statusText += `🔗 **Conexão:**\n`;
    if (!this.pjeClient) {
      statusText += `- Status: ❌ Cliente não configurado\n`;
      statusText += `- Solução: Execute 'pje_configurar' primeiro\n\n`;
    } else {
      statusText += `- Status: ✅ Cliente configurado\n`;
      if ((this.pjeClient as any).accessToken) {
        statusText += `- Autenticação: ✅ Token ativo\n`;
      } else if ((this.pjeClient as any).certificateManager) {
        statusText += `- Autenticação: 🔐 Certificado configurado\n`;
      } else {
        statusText += `- Autenticação: ⚠️ Apenas consultas públicas\n`;
      }
    }

    statusText += `\n💡 **Próximos passos:**\n`;
    if (!envConfig.baseUrl) {
      statusText += `1. Configure PJE_BASE_URL no arquivo .env\n`;
    }
    if (!envConfig.certificatePath && !envConfig.ssoUrl) {
      statusText += `2. Configure certificado digital ou credenciais SSO no arquivo .env\n`;
    }
    if (!this.pjeClient) {
      statusText += `3. Execute: 'Configure o PJE'\n`;
    } else {
      statusText += `3. ✅ Pronto para usar!\n`;
    }

    return {
      content: [
        {
          type: "text",
          text: statusText,
        },
      ],
    };
  }

  private async configurarCertificado(args: any) {
    try {
      const thumbprint = args.certificateThumbprint || process.env.PJE_CERTIFICATE_THUMBPRINT;
      const password = args.certificatePassword || process.env.PJE_CERTIFICATE_PASSWORD;
      if (!thumbprint || !password) {
        throw new Error('Thumbprint e senha do certificado são obrigatórios');
      }
      const certificateConfig: CertificateConfig = {
        certificateThumbprint: thumbprint,
        certificatePassword: password
      };

      if (!this.pjeClient) {
        const config: PJEConfig = {
          baseUrl: process.env.PJE_BASE_URL || "https://pje.tjce.jus.br",
          appName: process.env.PJE_APP_NAME || "pje-tjce-1g",
          certificate: certificateConfig,
        };
        this.pjeClient = new PJEClient(config);
      } else {
        (this.pjeClient as any).config.certificate = certificateConfig;
        (this.pjeClient as any).certificateManager = new CertificateManager(certificateConfig);
      }

      await this.pjeClient.initializeCertificate();
      
      try {
        await this.pjeClient.authenticateWithCertificate();
        return {
          content: [
            {
              type: "text",
              text: `🔐 **Certificado Digital Configurado com Sucesso!**\n\n✅ Certificado carregado e autenticado\n🎯 Pronto para usar com todas as funcionalidades do PJE\n\n**Informações do Certificado:**\n${JSON.stringify(this.pjeClient.getCertificateInfo(), null, 2)}`,
            },
          ],
        };
      } catch (authError) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️ **Certificado Carregado, mas Autenticação Falhou**\n\nCertificado foi carregado, mas a autenticação no PJE falhou.\nErro: ${authError}\n\n**Informações do Certificado:**\n${JSON.stringify(this.pjeClient.getCertificateInfo(), null, 2)}`,
            },
          ],
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ **Erro ao Configurar Certificado Digital**\n\n${error instanceof Error ? error.message : String(error)}\n\n**Dicas:**\n1. Verifique se o arquivo .pfx existe no caminho especificado\n2. Confirme se a senha do certificado está correta\n3. Para certificados do Windows, use o thumbprint ou subject\n4. Execute 'pje_listar_certificados' para ver certificados disponíveis`,
          },
        ],
      };
    }
  }

  private async listarCertificados() {
    try {
      const { stdout } = await execAsync('certutil -store My');
      return {
        content: [
          {
            type: "text",
            text: `🔍 **Certificados Digitais Disponíveis no Windows**\n\n${stdout}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ **Erro ao Listar Certificados**\n\n${error instanceof Error ? error.message : String(error)}\n\n**Nota:** Esta funcionalidade requer Windows e acesso ao Certificate Store.`,
          },
        ],
      };
    }
  }

  private async infoCertificado() {
    try {
      if (!this.pjeClient || !(this.pjeClient as any).certificateManager) {
        return {
          content: [
            {
              type: "text",
              text: `❌ **Nenhum Certificado Configurado**\n\nExecute 'pje_configurar_certificado' primeiro para carregar um certificado digital.`,
            },
          ],
        };
      }
      
      const info = this.pjeClient.getCertificateInfo();
      
      let texto = `🎯 **Informações do Certificado Digital Atual**\n\n`;
      
      texto += `**Subject:**\n`;
      info.subject.forEach((attr: any) => {
        texto += `- ${attr.name}: ${attr.value}\n`;
      });
      
      texto += `\n**Emissor:**\n`;
      info.issuer.forEach((attr: any) => {
        texto += `- ${attr.name}: ${attr.value}\n`;
      });
      
      texto += `\n**Detalhes Técnicos:**\n`;
      texto += `- Serial Number: ${info.serialNumber}\n`;
      texto += `- Thumbprint: ${info.thumbprint}\n`;
      texto += `- Válido de: ${new Date(info.notBefore).toLocaleString('pt-BR')}\n`;
      texto += `- Válido até: ${new Date(info.notAfter).toLocaleString('pt-BR')}\n`;
      
      const agora = new Date();
      const validade = new Date(info.notAfter);
      
      if (agora > validade) {
        texto += `\n⚠️ **AVISO: Certificado EXPIRADO!**\n`;
      } else {
        const diasRestantes = Math.floor((validade.getTime() - agora.getTime()) / (1000 * 60 * 60 * 24));
        texto += `\n✅ **Certificado válido por mais ${diasRestantes} dias**\n`;
      }
      
      return {
        content: [
          {
            type: "text",
            text: texto,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ **Erro ao Obter Informações do Certificado**\n\n${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Servidor MCP do PJE iniciado");
  }
}

const server = new PJEServer();
server.run().catch(console.error); 