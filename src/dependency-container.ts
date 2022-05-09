import DependencyContainer, {
  PostResolutionInterceptorCallback,
  PreResolutionInterceptorCallback,
  ResolutionType
} from "./types/dependency-container";
import {
  isClassProvider,
  isFactoryProvider,
  isNormalToken,
  isTokenProvider,
  isValueProvider
} from "./providers";
import Provider, {isProvider} from "./providers/provider";
import FactoryProvider from "./providers/factory-provider";
import InjectionToken, {
  isConstructorToken,
  isTokenDescriptor,
  isTransformDescriptor,
  TokenDescriptor
} from "./providers/injection-token";
import TokenProvider from "./providers/token-provider";
import ValueProvider from "./providers/value-provider";
import ClassProvider from "./providers/class-provider";
import RegistrationOptions from "./types/registration-options";
import constructor from "./types/constructor";
import Registry from "./registry";
import Lifecycle from "./types/lifecycle";
import ResolutionContext from "./resolution-context";
import {formatErrorCtor} from "./error-helpers";
import {DelayedConstructor} from "./lazy-helpers";
import Disposable, {isDisposable} from "./types/disposable";
import InterceptorOptions from "./types/interceptor-options";
import Interceptors from "./interceptors";

export type Registration<T = any> = {
  provider: Provider<T>;
  options: RegistrationOptions;
  instance?: T;
};

export type ParamInfo = TokenDescriptor | InjectionToken<any>;

// 被注入依赖的构造器都存在 typeInfo 里
export const typeInfo = new Map<constructor<any>, ParamInfo[]>();

/** Dependency Container */
class InternalDependencyContainer implements DependencyContainer {
  private _registry = new Registry();
  private interceptors = new Interceptors();
  private disposed = false;
  private disposables = new Set<Disposable>();

  public constructor(private parent?: InternalDependencyContainer) {}

  /**
   * Register a dependency provider.
   *
   * @param provider {Provider} The dependency provider
   */
  public register<T>(
    token: InjectionToken<T>,
    provider: ValueProvider<T>
  ): InternalDependencyContainer;
  public register<T>(
    token: InjectionToken<T>,
    provider: FactoryProvider<T>
  ): InternalDependencyContainer;
  public register<T>(
    token: InjectionToken<T>,
    provider: TokenProvider<T>,
    options?: RegistrationOptions
  ): InternalDependencyContainer;
  public register<T>(
    token: InjectionToken<T>,
    provider: ClassProvider<T>,
    options?: RegistrationOptions
  ): InternalDependencyContainer;
  public register<T>(
    token: InjectionToken<T>,
    provider: constructor<T>,
    options?: RegistrationOptions
  ): InternalDependencyContainer;
  public register<T>(
    token: InjectionToken<T>,
    providerOrConstructor: Provider<T> | constructor<T>,
    options: RegistrationOptions = {lifecycle: Lifecycle.Transient}
  ): InternalDependencyContainer {
    this.ensureNotDisposed();

    let provider: Provider<T>;

    if (!isProvider(providerOrConstructor)) {
      provider = {
        useClass: providerOrConstructor
      };
    } else {
      provider = providerOrConstructor;
    }

    // 如果是 token provider 则需要预处理，避免 useToken 循环
    // Search the token graph for cycles
    if (isTokenProvider(provider)) {
      const path = [token];

      let tokenProvider: TokenProvider<T> | null = provider;
      while (tokenProvider != null) {
        const currentToken = tokenProvider.useToken;
        if (path.includes(currentToken)) {
          throw new Error(
            `Token registration cycle detected! ${[...path, currentToken].join(
              " -> "
            )}`
          );
        }

        path.push(currentToken);

        const registration = this._registry.get(currentToken);

        if (registration && isTokenProvider(registration.provider)) {
          tokenProvider = registration.provider;
        } else {
          tokenProvider = null;
        }
      }
    }

    // 全局单例，容器单例，依赖调用链单例，不允许结合 value provider 和 factory provider 使用
    if (
      options.lifecycle === Lifecycle.Singleton ||
      options.lifecycle == Lifecycle.ContainerScoped ||
      options.lifecycle == Lifecycle.ResolutionScoped
    ) {
      if (isValueProvider(provider) || isFactoryProvider(provider)) {
        throw new Error(
          `Cannot use lifecycle "${
            Lifecycle[options.lifecycle]
          }" with ValueProviders or FactoryProviders`
        );
      }
    }

    // 登记 token 对应的 provider
    this._registry.set(token, {
      provider,
      options
    });

    // 返回容器
    return this;
  }
  /** 注册 transient 类型生命周期的 dependency provider，token 无限制，provider 为 tokenProvider(string or symbol) or classProvider(constructor) */
  public registerType<T>(
    from: InjectionToken<T>,
    to: InjectionToken<T>
  ): InternalDependencyContainer {
    this.ensureNotDisposed();

    if (isNormalToken(to)) {
      return this.register(from, {
        useToken: to
      });
    }

    return this.register(from, {
      useClass: to
    });
  }

  /** 注册 transient 类型生命周期的 dependency provider，token 无限制，provider 为 valueProvider(instance)  */
  public registerInstance<T>(
    token: InjectionToken<T>,
    instance: T
  ): InternalDependencyContainer {
    this.ensureNotDisposed();

    return this.register(token, {
      useValue: instance
    });
  }

  /** 注册 singleton 类型生命周期的 dependency provider，token 为 string or symbol，provider 为 tokenProvider(string or symbol) or classProvider(constructor)   */
  public registerSingleton<T>(
    from: InjectionToken<T>,
    to: InjectionToken<T>
  ): InternalDependencyContainer;
  /** 注册 singleton 类型生命周期的 dependency provider，token 为 constructor，provider 为 classProvider(constructor)   */
  public registerSingleton<T>(
    token: constructor<T>,
    to?: constructor<any>
  ): InternalDependencyContainer;
  public registerSingleton<T>(
    from: InjectionToken<T>,
    to?: InjectionToken<T>
  ): InternalDependencyContainer {
    this.ensureNotDisposed();

    if (isNormalToken(from)) {
      if (isNormalToken(to)) {
        return this.register(
          from,
          {
            useToken: to
          },
          {lifecycle: Lifecycle.Singleton}
        );
      } else if (to) {
        return this.register(
          from,
          {
            useClass: to
          },
          {lifecycle: Lifecycle.Singleton}
        );
      }

      throw new Error(
        'Cannot register a type name as a singleton without a "to" token'
      );
    }

    let useClass = from;
    if (to && !isNormalToken(to)) {
      useClass = to;
    }

    return this.register(
      from,
      {
        useClass
      },
      {lifecycle: Lifecycle.Singleton}
    );
  }

  /** token 换 instance */
  public resolve<T>(
    token: InjectionToken<T>,
    context: ResolutionContext = new ResolutionContext()
  ): T {
    this.ensureNotDisposed();

    // 获取 token 对应注册信息 { provider, lifecycle, instance }, 只有依赖才会注册到 registration 中
    const registration = this.getRegistration(token);

    // 如果未注册，且 token 是 string 或者 symbol 则抛出异常
    if (!registration && isNormalToken(token)) {
      throw new Error(
        `Attempted to resolve unregistered dependency token: "${token.toString()}"`
      );
    }

    this.executePreResolutionInterceptor<T>(token, "Single");

    // 如果依赖已经注册
    if (registration) {
      const result = this.resolveRegistration(registration, context) as T;

      this.executePostResolutionInterceptor(token, result, "Single");
      return result;
    }

    // No registration for this token, but since it's a constructor, return an instance
    // resolve 被注入依赖的构造器
    if (isConstructorToken(token)) {
      const result = this.construct(token, context);
      this.executePostResolutionInterceptor(token, result, "Single");
      return result;
    }

    throw new Error(
      "Attempted to construct an undefined constructor. Could mean a circular dependency problem. Try using `delay` function."
    );
  }

  /** 执行 resolve 前的钩子函数，可以对 token 进行预处理 */
  private executePreResolutionInterceptor<T>(
    token: InjectionToken<T>,
    resolutionType: ResolutionType
  ): void {
    if (this.interceptors.preResolution.has(token)) {
      const remainingInterceptors = [];
      for (const interceptor of this.interceptors.preResolution.getAll(token)) {
        if (interceptor.options.frequency != "Once") {
          remainingInterceptors.push(interceptor);
        }
        interceptor.callback(token, resolutionType);
      }

      this.interceptors.preResolution.setAll(token, remainingInterceptors);
    }
  }

  /** 执行 resolve 后的钩子函数，可以对生成的实例 result 进行处理 */
  private executePostResolutionInterceptor<T>(
    token: InjectionToken<T>,
    result: T | T[],
    resolutionType: ResolutionType
  ): void {
    if (this.interceptors.postResolution.has(token)) {
      const remainingInterceptors = [];
      for (const interceptor of this.interceptors.postResolution.getAll(
        token
      )) {
        if (interceptor.options.frequency != "Once") {
          remainingInterceptors.push(interceptor);
        }
        interceptor.callback(token, result, resolutionType);
      }

      this.interceptors.postResolution.setAll(token, remainingInterceptors);
    }
  }

  /** 解析注册信息 */
  private resolveRegistration<T>(
    registration: Registration,
    context: ResolutionContext
  ): T {
    this.ensureNotDisposed();

    // If we have already resolved this scoped dependency, return it
    if (
      registration.options.lifecycle === Lifecycle.ResolutionScoped &&
      context.scopedResolutions.has(registration)
    ) {
      return context.scopedResolutions.get(registration);
    }

    const isSingleton = registration.options.lifecycle === Lifecycle.Singleton;
    const isContainerScoped =
      registration.options.lifecycle === Lifecycle.ContainerScoped;

    const returnInstance = isSingleton || isContainerScoped;

    let resolved: T;

    if (isValueProvider(registration.provider)) {
      resolved = registration.provider.useValue;
    } else if (isTokenProvider(registration.provider)) {
      // transient 和 resolutionScoped 不需要缓存 instance 在 provider 中
      resolved = returnInstance
        ? registration.instance ||
          (registration.instance = this.resolve(
            registration.provider.useToken,
            context
          ))
        : this.resolve(registration.provider.useToken, context);
    } else if (isClassProvider(registration.provider)) {
      // transient 和 resolutionScoped 不需要缓存 instance 在 provider 中
      resolved = returnInstance
        ? registration.instance ||
          (registration.instance = this.construct(
            registration.provider.useClass,
            context
          ))
        : this.construct(registration.provider.useClass, context);
    } else if (isFactoryProvider(registration.provider)) {
      resolved = registration.provider.useFactory(this);
    } else {
      resolved = this.construct(registration.provider, context);
    }

    // If this is a scoped dependency, store resolved instance in context
    // 缓存 resolutionScoped lifecycle 的 instance 到 resolve 上下文中
    if (registration.options.lifecycle === Lifecycle.ResolutionScoped) {
      context.scopedResolutions.set(registration, resolved);
    }

    return resolved;
  }

  public resolveAll<T>(
    token: InjectionToken<T>,
    context: ResolutionContext = new ResolutionContext()
  ): T[] {
    this.ensureNotDisposed();

    const registrations = this.getAllRegistrations(token);

    if (!registrations && isNormalToken(token)) {
      throw new Error(
        `Attempted to resolve unregistered dependency token: "${token.toString()}"`
      );
    }

    this.executePreResolutionInterceptor(token, "All");

    if (registrations) {
      const result = registrations.map(item =>
        this.resolveRegistration<T>(item, context)
      );

      this.executePostResolutionInterceptor(token, result, "All");
      return result;
    }

    // No registration for this token, but since it's a constructor, return an instance
    const result = [this.construct(token as constructor<T>, context)];
    this.executePostResolutionInterceptor(token, result, "All");
    return result;
  }

  public isRegistered<T>(token: InjectionToken<T>, recursive = false): boolean {
    this.ensureNotDisposed();

    return (
      this._registry.has(token) ||
      (recursive &&
        (this.parent || false) &&
        this.parent.isRegistered(token, true))
    );
  }

  /** 清除注册信息，和所有钩子方法 */
  public reset(): void {
    this.ensureNotDisposed();
    this._registry.clear();
    this.interceptors.preResolution.clear();
    this.interceptors.postResolution.clear();
  }

  /** 清除注册信息上的实例属性，并剔除 value provider */
  public clearInstances(): void {
    this.ensureNotDisposed();

    for (const [token, registrations] of this._registry.entries()) {
      this._registry.setAll(
        token,
        registrations
          // Clear ValueProvider registrations
          .filter(registration => !isValueProvider(registration.provider))
          // Clear instances
          .map(registration => {
            registration.instance = undefined;
            return registration;
          })
      );
    }
  }

  /** 创建子容器 */
  public createChildContainer(): DependencyContainer {
    this.ensureNotDisposed();

    const childContainer = new InternalDependencyContainer(this);

    for (const [token, registrations] of this._registry.entries()) {
      // If there are any ContainerScoped registrations, we need to copy
      // ALL registrations to the child container, if we were to copy just
      // the ContainerScoped registrations, we would lose access to the others
      if (
        registrations.some(
          ({options}) => options.lifecycle === Lifecycle.ContainerScoped
        )
      ) {
        childContainer._registry.setAll(
          token,
          registrations.map<Registration>(registration => {
            if (registration.options.lifecycle === Lifecycle.ContainerScoped) {
              return {
                provider: registration.provider,
                options: registration.options
              };
            }

            return registration;
          })
        );
      }
    }

    return childContainer;
  }

  /** this.interceptors.preResolution API */
  beforeResolution<T>(
    token: InjectionToken<T>,
    callback: PreResolutionInterceptorCallback<T>,
    options: InterceptorOptions = {frequency: "Always"}
  ): void {
    this.interceptors.preResolution.set(token, {
      callback: callback,
      options: options
    });
  }

  /** this.interceptors.postResolution API */
  afterResolution<T>(
    token: InjectionToken<T>,
    callback: PostResolutionInterceptorCallback<T>,
    options: InterceptorOptions = {frequency: "Always"}
  ): void {
    this.interceptors.postResolution.set(token, {
      callback: callback,
      options: options
    });
  }

  /** 销毁容器 */
  public async dispose(): Promise<void> {
    this.disposed = true;

    const promises: Promise<unknown>[] = [];
    this.disposables.forEach(disposable => {
      const maybePromise = disposable.dispose();

      if (maybePromise) {
        promises.push(maybePromise);
      }
    });

    await Promise.all(promises);
  }

  /** 获取注册信息 */
  private getRegistration<T>(token: InjectionToken<T>): Registration | null {
    if (this.isRegistered(token)) {
      return this._registry.get(token)!;
    }

    if (this.parent) {
      return this.parent.getRegistration(token);
    }

    return null;
  }

  private getAllRegistrations<T>(
    token: InjectionToken<T>
  ): Registration[] | null {
    if (this.isRegistered(token)) {
      return this._registry.getAll(token);
    }

    if (this.parent) {
      return this.parent.getAllRegistrations(token);
    }

    return null;
  }

  /** 根据 provider 构造器生成实例 */
  private construct<T>(
    ctor: constructor<T> | DelayedConstructor<T>,
    context: ResolutionContext
  ): T {
    // 如果是 DelayedConstructor，延后初始化实例，处理循环依赖
    if (ctor instanceof DelayedConstructor) {
      return ctor.createProxy((target: constructor<T>) =>
        this.resolve(target, context)
      );
    }

    // 立即初始化实例
    const instance: T = (() => {
      // 获取装饰器 injectable 存入 typeInfo 的被注入依赖的构造器的参数描述器，参数描述器包含注入依赖的 token 和 transform 信息，
      const paramInfo = typeInfo.get(ctor);

      // 判断所需参数为空
      if (!paramInfo || paramInfo.length === 0) {
        // 如果构造器的所需要的参数为空，则直接返回实例
        if (ctor.length === 0) {
          return new ctor();
        } else {
          throw new Error(`TypeInfo not known for "${ctor.name}"`);
        }
      }

      // 参数不为空，则对参数信息处理
      const params = paramInfo.map(this.resolveParams(context, ctor));

      // 注入 params 依赖，构造实例
      return new ctor(...params);
    })();

    // 实例是否含有 dispose 方法，如果有，则将实例添加到 disposables 中，以便 dispose 时调用
    if (isDisposable(instance)) {
      this.disposables.add(instance);
    }

    // 返回构造的实例
    return instance;
  }

  /** 返回函数，该函数通过对参数描述器进行处理，进行递归 resolve，并生成依赖实例返回，做为依赖注入 */
  private resolveParams<T>(context: ResolutionContext, ctor: constructor<T>) {
    return (param: ParamInfo, idx: number) => {
      try {
        // 判断参数描述器，如果是 token 描述器，参数使用了 injectAll 或者 injectAllTransform 装饰器
        if (isTokenDescriptor(param)) {
          // 判断参数描述器，如果即是 token 描述器也是 transform 描述器。参数使用了 injectAllTransform 装饰器
          if (isTransformDescriptor(param)) {
            // 这儿是为了处理 injectAllTransform 装饰器的逻辑，如果是 injectAllTransform 装饰器，
            // 则需要将 transform token 指向的实例取出作为 transform，
            // 再通过 param token 取出所有要注入的参数依赖实例并通过 transform 函数执行一遍，再返回参数实例
            return param.multiple
              ? this.resolve(param.transform).transform(
                  // resolve param token 对应的要注入的依赖实例
                  this.resolveAll(param.token),
                  ...param.transformArgs
                )
              : // 这一步在当前版本里面不会执行，没有装饰器对应该逻辑
                this.resolve(param.transform).transform(
                  this.resolve(param.token, context),
                  ...param.transformArgs
                );
            // 参数使用了 injectAll 装饰器
          } else {
            return param.multiple
              ? // resolve param token 对应的要注入的依赖实例
                this.resolveAll(param.token)
              : // 这一步在当前版本里面不会执行，没有装饰器对应该逻辑
                this.resolve(param.token, context);
          }
          // 判断参数描述器，如果是 transform 描述器。如果参数使用了 injectTransform 装饰器
        } else if (isTransformDescriptor(param)) {
          // 则 resolve 出 transform token 对应的实例，并调用 transform 方法
          return this.resolve(param.transform, context).transform(
            //  resolve 出 param token 对应的要注入依赖的实例
            this.resolve(param.token, context),
            ...param.transformArgs
          );
        }
        //调用 inject 装饰器，resolve 出 param token 对应的实例
        return this.resolve(param, context);
      } catch (e) {
        throw new Error(formatErrorCtor(ctor, idx, e));
      }
    };
  }

  /** 判断没有销毁容器 */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error(
        "This container has been disposed, you cannot interact with a disposed container"
      );
    }
  }
}

export const instance: DependencyContainer = new InternalDependencyContainer();

export default instance;
