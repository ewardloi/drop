FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY Drop.Server/Drop.Server.csproj Drop.Server/
RUN dotnet restore Drop.Server/Drop.Server.csproj

COPY Drop.Server/ Drop.Server/

RUN dotnet publish Drop.Server/Drop.Server.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app

ENV ASPNETCORE_URLS=http://+:5000 \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_EnableDiagnostics=0

COPY --from=build /app/publish .

EXPOSE 5000
ENTRYPOINT ["dotnet", "Drop.Server.dll"]
